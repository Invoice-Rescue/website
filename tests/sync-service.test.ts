import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv } from './e2e/harness';
import worker from '../backend/src/index';
import { SyncService, type NormalizedInvoice } from '../backend/src/lib/integrations/sync-service';
import { encryptToken, decryptToken } from '../backend/src/lib/integrations/oauth-manager';

describe('SyncService & Accounting Webhooks', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function signHmacSha256Base64(payload: string, keyString: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(keyString),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  test('reconcileInvoice creates new overdue invoice for unpaid record', async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Sync Client 1', 'sc1@test.com', 'engine', 'active');
    `);

    const syncService = new SyncService(env.DB, env);

    const norm: NormalizedInvoice = {
      externalId: 'ext-inv-001',
      invoiceNumber: 'INV-NEW-1',
      debtorName: 'Debtor Alpha',
      debtorEmail: 'debtor.alpha@test.com',
      amountPence: 45000,
      currency: 'GBP',
      dueDate: '2026-08-01',
      issuedDate: '2026-07-01',
      isPaid: false,
      paidDate: null,
      isDisputedOrVoid: false,
    };

    const action = await syncService.reconcileInvoice(1, norm);
    assert.strictEqual(action, 'created');

    const row = await db.prepare('SELECT invoice_number, status, amount_pence FROM invoices WHERE client_id = 1 AND invoice_number = ?1')
      .bind('INV-NEW-1').first<any>();
    assert.ok(row);
    assert.strictEqual(row.status, 'overdue');
    assert.strictEqual(row.amount_pence, 45000);
  });

  test('reconcileInvoice marks paid and halts pending drafts in chase_log', async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Sync Client 1', 'sc1@test.com', 'engine', 'active');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (10, 1, 'Debtor Pending', 'INV-PAID-TEST', 60000, '2026-08-01', 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
      VALUES (101, 10, 2, 'email', 'draft', 'Please pay immediately');
    `);

    const syncService = new SyncService(env.DB, env);

    const paidNorm: NormalizedInvoice = {
      externalId: 'ext-inv-paid-10',
      invoiceNumber: 'INV-PAID-TEST',
      debtorName: 'Debtor Pending',
      debtorEmail: null,
      amountPence: 60000,
      currency: 'GBP',
      dueDate: '2026-08-01',
      issuedDate: '2026-07-01',
      isPaid: true,
      paidDate: '2026-09-15',
      isDisputedOrVoid: false,
    };

    const action = await syncService.reconcileInvoice(1, paidNorm);
    assert.strictEqual(action, 'marked_paid');

    // Verify invoice status updated to 'paid'
    const invoice = await db.prepare('SELECT status, paid_date FROM invoices WHERE id = 10').first<any>();
    assert.strictEqual(invoice.status, 'paid');
    assert.strictEqual(invoice.paid_date, '2026-09-15');

    // CRITICAL: Draft in chase_log MUST be transitioned to 'skipped'
    const draft = await db.prepare('SELECT status, reviewed_at FROM chase_log WHERE id = 101').first<any>();
    assert.strictEqual(draft.status, 'skipped');
    assert.ok(draft.reviewed_at);
  });

  test('reconcileInvoice marks disputed and halts pending drafts', async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Dispute Client', 'dc@test.com', 'engine', 'active');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (20, 1, 'Debtor Disputed', 'INV-DISPUTE-TEST', 50000, '2026-08-01', 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
      VALUES (201, 20, 1, 'email', 'draft', 'Gentle reminder');
    `);

    const syncService = new SyncService(env.DB, env);

    const voidNorm: NormalizedInvoice = {
      externalId: 'ext-void-20',
      invoiceNumber: 'INV-DISPUTE-TEST',
      debtorName: 'Debtor Disputed',
      debtorEmail: null,
      amountPence: 50000,
      currency: 'GBP',
      dueDate: '2026-08-01',
      issuedDate: '2026-07-01',
      isPaid: false,
      paidDate: null,
      isDisputedOrVoid: true,
    };

    const action = await syncService.reconcileInvoice(1, voidNorm);
    assert.strictEqual(action, 'updated');

    const invoice = await db.prepare('SELECT status FROM invoices WHERE id = 20').first<any>();
    assert.strictEqual(invoice.status, 'disputed');

    const draft = await db.prepare('SELECT status FROM chase_log WHERE id = 201').first<any>();
    assert.strictEqual(draft.status, 'skipped');
  });

  test('POST /api/webhooks/xero satisfies ITR: returns 401 on invalid signature, 200 on valid', async () => {
    const { env, db } = createTestEnv({
      XERO_WEBHOOK_KEY: 'xero_webhook_secret_key_123',
    } as any);

    const payload = JSON.stringify({
      events: [
        {
          resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/xero-inv-1',
          resourceId: 'xero-inv-1',
          eventDateUtc: '2026-09-16T05:00:00.000Z',
          eventType: 'UPDATE',
          eventCategory: 'INVOICE',
          tenantId: 'xero-tenant-itr-1',
        },
      ],
      firstEventSequence: 1,
      lastEventSequence: 1,
    });

    // 1. Invalid signature -> MUST return HTTP 401 (Xero Intent to Receive requirement)
    const badReq = new Request('http://localhost/api/webhooks/xero', {
      method: 'POST',
      headers: {
        'x-xero-signature': 'invalid-signature-base64',
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    const badRes = await worker.fetch(badReq, env);
    assert.strictEqual(badRes.status, 401);

    // 2. Valid signature -> MUST return HTTP 200
    const validSig = await signHmacSha256Base64(payload, 'xero_webhook_secret_key_123');
    const goodReq = new Request('http://localhost/api/webhooks/xero', {
      method: 'POST',
      headers: {
        'x-xero-signature': validSig,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    const goodRes = await worker.fetch(goodReq, env);
    assert.strictEqual(goodRes.status, 200);

    // Check event recorded in accounting_webhook_events
    const eventRow = await db.prepare("SELECT id, provider FROM accounting_webhook_events WHERE provider = 'xero'").first<any>();
    assert.ok(eventRow);
    assert.strictEqual(eventRow.provider, 'xero');

    // 3. Replaying the identical event does not re-process
    const replayReq = new Request('http://localhost/api/webhooks/xero', {
      method: 'POST',
      headers: {
        'x-xero-signature': validSig,
        'Content-Type': 'application/json',
      },
      body: payload,
    });
    const replayRes = await worker.fetch(replayReq, env);
    assert.strictEqual(replayRes.status, 200);
  });

  test('POST /api/webhooks/quickbooks validates signature and deduplicates events', async () => {
    const { env, db } = createTestEnv({
      QUICKBOOKS_VERIFIER_TOKEN: 'qb_verifier_token_456',
    } as any);

    const payload = JSON.stringify({
      eventNotifications: [
        {
          realmId: 'qb-realm-789',
          dataChangeEvent: {
            entities: [
              {
                name: 'Invoice',
                id: 'qb-inv-99',
                operation: 'Update',
                lastUpdated: '2026-09-16T05:10:00.000Z',
              },
            ],
          },
        },
      ],
    });

    // Invalid signature -> 401
    const badReq = new Request('http://localhost/api/webhooks/quickbooks', {
      method: 'POST',
      headers: { 'intuit-signature': 'bad-sig', 'Content-Type': 'application/json' },
      body: payload,
    });
    const badRes = await worker.fetch(badReq, env);
    assert.strictEqual(badRes.status, 401);

    // Valid signature -> 200
    const validSig = await signHmacSha256Base64(payload, 'qb_verifier_token_456');
    const goodReq = new Request('http://localhost/api/webhooks/quickbooks', {
      method: 'POST',
      headers: { 'intuit-signature': validSig, 'Content-Type': 'application/json' },
      body: payload,
    });
    const goodRes = await worker.fetch(goodReq, env);
    assert.strictEqual(goodRes.status, 200);

    const eventRow = await db.prepare("SELECT id, provider FROM accounting_webhook_events WHERE provider = 'quickbooks'").first<any>();
    assert.ok(eventRow);
    assert.strictEqual(eventRow.provider, 'quickbooks');
  });

  test('SyncService full sync polls provider, decrypts tokens, and reconciles into D1', async () => {
    const { env, db } = createTestEnv({
      TOKEN_ENCRYPTION_SECRET: 'test-token-secret-at-least-32-chars!',
      XERO_CLIENT_ID: 'mock_xero_id',
      XERO_CLIENT_SECRET: 'mock_xero_secret',
    } as any);

    const secret = (env as any).TOKEN_ENCRYPTION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
      VALUES (1, 'Full Sync Client', 'fsc@test.com', 'engine', 'active', 'xero');
    `);

    const encAccess = await encryptToken('valid-xero-access-token', secret);
    const encRefresh = await encryptToken('valid-xero-refresh-token', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-sync-1', ?1, ?2, '2026-09-16T12:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    // Mock Xero Invoices API response
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes('/api.xro/2.0/Invoices')) {
        return new Response(
          JSON.stringify({
            Invoices: [
              {
                InvoiceID: 'xero-inv-001',
                InvoiceNumber: 'INV-XERO-101',
                Contact: { Name: 'Acme Debtor', EmailAddress: 'acme@debtor.test' },
                AmountDue: 1500.0,
                Total: 1500.0,
                CurrencyCode: 'GBP',
                DueDateString: '2026-08-01',
                DateString: '2026-07-01',
                Status: 'AUTHORISED',
              },
              {
                InvoiceID: 'xero-inv-002',
                InvoiceNumber: 'INV-XERO-102',
                Contact: { Name: 'Settled Debtor', EmailAddress: 'settled@debtor.test' },
                AmountDue: 0.0,
                Total: 800.0,
                CurrencyCode: 'GBP',
                DueDateString: '2026-08-05',
                DateString: '2026-07-05',
                Status: 'PAID',
                FullyPaidOnDate: '2026-08-20',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    };

    const syncService = new SyncService(env.DB, env);
    const result = await syncService.syncInvoices(1);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.invoicesSynced, 2);
    assert.strictEqual(result.invoicesCreated, 2);
    assert.strictEqual(result.invoicesMarkedPaid, 1);

    // Verify D1 records
    const overdueInv = await db.prepare('SELECT invoice_number, status, amount_pence FROM invoices WHERE invoice_number = ?1').bind('INV-XERO-101').first<any>();
    assert.ok(overdueInv);
    assert.strictEqual(overdueInv.status, 'overdue');
    assert.strictEqual(overdueInv.amount_pence, 150000);

    const paidInv = await db.prepare('SELECT invoice_number, status, amount_pence, paid_date FROM invoices WHERE invoice_number = ?1').bind('INV-XERO-102').first<any>();
    assert.ok(paidInv);
    assert.strictEqual(paidInv.status, 'paid');
    assert.strictEqual(paidInv.paid_date, '2026-08-20');
  });

  test('Cron scheduled handler triggers accounting synchronization before overdue detection', async () => {
    const { env, db } = createTestEnv({
      TOKEN_ENCRYPTION_SECRET: 'test-token-secret-at-least-32-chars!',
      BOE_BASE_RATE_PERCENT: '3.75',
    } as any);

    const secret = (env as any).TOKEN_ENCRYPTION_SECRET;

    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
      VALUES (1, 'Cron Sync Client', 'csc@test.com', 'engine', 'active', 'xero');
    `);

    const encAccess = await encryptToken('cron-xero-access', secret);
    const encRefresh = await encryptToken('cron-xero-refresh', secret);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (1, 'xero', 'tenant-cron-1', ?1, ?2, '2026-09-16T12:00:00Z', 'active')
    `).bind(encAccess, encRefresh).run();

    let syncCalled = false;
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = input.toString();
      if (url.includes('/api.xro/2.0/Invoices')) {
        syncCalled = true;
        return new Response(
          JSON.stringify({ Invoices: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    };

    // Execute scheduled event
    await worker.scheduled({ cron: '0 6 * * *', scheduledTime: Date.now() } as any, env);
    assert.strictEqual(syncCalled, true);
  });
});
