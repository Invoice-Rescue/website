import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestEnv, signHmacSha256 } from './e2e/harness';
import worker from '../backend/src/index';
import { SyncService, type NormalizedInvoice } from '../backend/src/lib/integrations/sync-service';
import {
  generateOAuthState,
  verifyOAuthState,
  encryptToken,
  decryptToken,
} from '../backend/src/lib/integrations/oauth-manager';
import {
  recordAccountingWebhook,
  getAccountingConnection,
  InvalidWebhookEventError,
} from '../backend/src/lib/tenant-repo';
import { verifyXeroWebhook, verifyQuickBooksWebhook } from '../backend/src/lib/integrations/webhooks';
import { buildSessionCookie } from '../backend/src/lib/portal-auth';

describe('Empirical Challenger 2 — Milestone M1 Stress Suite', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // SUITE 1: Webhook HMAC Signature Tampering & Edge Cases
  // =========================================================================
  describe('1. Webhook HMAC Cryptographic Validation & Tampering', () => {
    const xeroSecret = 'xero_super_secret_webhook_key_2026!';
    const qbSecret = 'quickbooks_verifier_token_secret_999!';

    const sampleXeroPayload = JSON.stringify({
      events: [
        {
          resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/inv-test-100',
          resourceId: 'inv-test-100',
          eventDateUtc: '2026-09-16T05:30:00.000Z',
          eventType: 'UPDATE',
          eventCategory: 'INVOICE',
          tenantId: 'tenant-xero-stress-1',
        },
      ],
      firstEventSequence: 1,
      lastEventSequence: 1,
    });

    const sampleQbPayload = JSON.stringify({
      eventNotifications: [
        {
          realmId: 'qb-realm-stress-1',
          dataChangeEvent: {
            entities: [
              {
                name: 'Invoice',
                id: 'qb-inv-stress-100',
                operation: 'Update',
                lastUpdated: '2026-09-16T05:30:00.000Z',
              },
            ],
          },
        },
      ],
    });

    test('Xero: Valid HMAC signature returns 200', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const validSig = await signHmacSha256(sampleXeroPayload, xeroSecret);

      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: sampleXeroPayload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
    });

    test('Xero: Tampered signature byte returns 401', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const validSig = await signHmacSha256(sampleXeroPayload, xeroSecret);
      // Flip a character in the base64 signature
      const tamperedSig = validSig.slice(0, -2) + (validSig.endsWith('A') ? 'B' : 'A') + validSig.slice(-1);

      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': tamperedSig,
          'Content-Type': 'application/json',
        },
        body: sampleXeroPayload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401, 'Tampered HMAC signature must return 401');
    });

    test('Xero: Tampered payload with original signature returns 401', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const validSig = await signHmacSha256(sampleXeroPayload, xeroSecret);
      // Append a single space to payload
      const tamperedPayload = sampleXeroPayload + ' ';

      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: tamperedPayload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401, 'Tampered payload with valid signature must return 401');
    });

    test('Xero: Missing signature header returns 401', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sampleXeroPayload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401, 'Missing signature header must return 401');
    });

    test('Xero: Signature signed with wrong secret key returns 401', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const wrongSig = await signHmacSha256(sampleXeroPayload, 'completely-different-key-12345!');

      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': wrongSig,
          'Content-Type': 'application/json',
        },
        body: sampleXeroPayload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401, 'Signature with wrong key must return 401');
    });

    test('Xero: Malformed and truncated signature strings return 401 without crashing', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const testCases = [
        '',
        'short',
        '==invalid-base64==',
        '1234567890123456789012345678901234567890123', // 43 chars
        '123456789012345678901234567890123456789012345', // 45 chars
        'null',
        'undefined',
      ];

      for (const badSig of testCases) {
        const req = new Request('http://localhost/api/webhooks/xero', {
          method: 'POST',
          headers: {
            'x-xero-signature': badSig,
            'Content-Type': 'application/json',
          },
          body: sampleXeroPayload,
        });
        const res = await worker.fetch(req, env);
        assert.strictEqual(res.status, 401, `Signature "${badSig}" must return 401`);
      }
    });

    test('Xero ITR: Empty body handshake with valid signature returns 200, invalid returns 401', async () => {
      const { env } = createTestEnv({ XERO_WEBHOOK_KEY: xeroSecret } as any);
      const emptyBody = '';

      // Invalid signature on ITR probe -> MUST return 401
      const badReq = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': 'invalid-itr-sig',
          'Content-Type': 'application/json',
        },
        body: emptyBody,
      });
      const badRes = await worker.fetch(badReq, env);
      assert.strictEqual(badRes.status, 401, 'Xero ITR probe with invalid signature must return 401');

      // Valid signature on ITR probe -> MUST return 200
      const validSig = await signHmacSha256(emptyBody, xeroSecret);
      const goodReq = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: emptyBody,
      });
      const goodRes = await worker.fetch(goodReq, env);
      assert.strictEqual(goodRes.status, 200, 'Xero ITR probe with valid signature must return 200');
    });

    test('QuickBooks: Valid signature returns 200, tampered signature returns 401', async () => {
      const { env } = createTestEnv({ QUICKBOOKS_VERIFIER_TOKEN: qbSecret } as any);

      // Valid
      const validSig = await signHmacSha256(sampleQbPayload, qbSecret);
      const reqGood = new Request('http://localhost/api/webhooks/quickbooks', {
        method: 'POST',
        headers: {
          'intuit-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: sampleQbPayload,
      });
      const resGood = await worker.fetch(reqGood, env);
      assert.strictEqual(resGood.status, 200);

      // Tampered signature
      const tamperedSig = validSig.slice(0, 10) + 'X' + validSig.slice(11);
      const reqBadSig = new Request('http://localhost/api/webhooks/quickbooks', {
        method: 'POST',
        headers: {
          'intuit-signature': tamperedSig,
          'Content-Type': 'application/json',
        },
        body: sampleQbPayload,
      });
      const resBadSig = await worker.fetch(reqBadSig, env);
      assert.strictEqual(resBadSig.status, 401, 'QuickBooks tampered signature must return 401');

      // Tampered payload
      const reqBadPayload = new Request('http://localhost/api/webhooks/quickbooks', {
        method: 'POST',
        headers: {
          'intuit-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: sampleQbPayload + '{"injected":true}',
      });
      const resBadPayload = await worker.fetch(reqBadPayload, env);
      assert.strictEqual(resBadPayload.status, 401, 'QuickBooks tampered payload must return 401');

      // Missing signature
      const reqMissing = new Request('http://localhost/api/webhooks/quickbooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sampleQbPayload,
      });
      const resMissing = await worker.fetch(reqMissing, env);
      assert.strictEqual(resMissing.status, 401, 'QuickBooks missing signature must return 401');
    });

    test('OAuth state token: Tampering and replay protection', async () => {
      const stateSecret = 'oauth-state-secret-at-least-32-chars-long!';
      const validState = await generateOAuthState(
        { cid: 7, p: 'xero', ret: '/portal/dashboard' },
        stateSecret,
        600
      );

      // Valid verifies
      const parsed = await verifyOAuthState(validState, stateSecret, 'xero');
      assert.ok(parsed);
      assert.strictEqual(parsed.cid, 7);
      assert.strictEqual(parsed.p, 'xero');

      // Tampered payload (change cid 7 to cid 1)
      const [pB64, sigB64] = validState.split('.');
      const pDecoded = JSON.parse(atob(pB64.replace(/-/g, '+').replace(/_/g, '/')));
      pDecoded.cid = 1;
      const tamperedPB64 = btoa(JSON.stringify(pDecoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const tamperedState = `${tamperedPB64}.${sigB64}`;

      const resTampered = await verifyOAuthState(tamperedState, stateSecret, 'xero');
      assert.strictEqual(resTampered, null, 'Tampered OAuth state payload must fail verification');

      // Expired state (negative TTL)
      const expiredState = await generateOAuthState(
        { cid: 7, p: 'xero', ret: '/portal/dashboard' },
        stateSecret,
        -10 // expired 10 seconds ago
      );
      const resExpired = await verifyOAuthState(expiredState, stateSecret, 'xero');
      assert.strictEqual(resExpired, null, 'Expired OAuth state must return null');

      // Provider mismatch
      const resWrongProvider = await verifyOAuthState(validState, stateSecret, 'quickbooks');
      assert.strictEqual(resWrongProvider, null, 'Provider mismatch must return null');
    });
  });

  // =========================================================================
  // SUITE 2: Webhook Deduplication & Idempotency
  // =========================================================================
  describe('2. Webhook Deduplication & Idempotent Processing', () => {
    const xeroSecret = 'xero_dedup_secret_key_12345';
    const qbSecret = 'qb_dedup_secret_token_12345';

    test('Xero: 50 sequential replays of identical event trigger DB side-effect exactly once', async () => {
      const { env, db } = createTestEnv({
        XERO_WEBHOOK_KEY: xeroSecret,
        TOKEN_ENCRYPTION_SECRET: 'secret-key-32-chars-long-test-123!',
      } as any);

      // Setup client and active connection
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (10, 'Dedup Client', 'dedup@test.com', 'engine', 'active', 'xero');
      `);

      const encToken = await encryptToken('mock-xero-access', 'secret-key-32-chars-long-test-123!');
      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (10, 'xero', 'tenant-dedup-xero', ?1, ?1, '2026-09-17T00:00:00Z', 'active')
      `).bind(encToken).run();

      let syncSingleInvoiceCalls = 0;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url.includes('/api.xro/2.0/Invoices/')) {
          syncSingleInvoiceCalls++;
          return new Response(JSON.stringify({
            Invoices: [{
              InvoiceID: 'inv-dedup-1',
              InvoiceNumber: 'INV-DEDUP-001',
              Contact: { Name: 'Dedup Debtor' },
              AmountDue: 250.0,
              Total: 250.0,
              Status: 'AUTHORISED',
              DueDateString: '2026-08-10',
            }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      };

      const payload = JSON.stringify({
        events: [{
          resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/inv-dedup-1',
          resourceId: 'inv-dedup-1',
          eventDateUtc: '2026-09-16T05:00:00.000Z',
          eventType: 'UPDATE',
          eventCategory: 'INVOICE',
          tenantId: 'tenant-dedup-xero',
        }],
        firstEventSequence: 1,
        lastEventSequence: 1,
      });

      const signature = await signHmacSha256(payload, xeroSecret);

      // Replay 50 times
      for (let i = 0; i < 50; i++) {
        const req = new Request('http://localhost/api/webhooks/xero', {
          method: 'POST',
          headers: {
            'x-xero-signature': signature,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        const res = await worker.fetch(req, env);
        assert.strictEqual(res.status, 200);
      }

      // Check accounting_webhook_events has exactly 1 entry
      const countRow = await db.prepare(
        "SELECT COUNT(*) as count FROM accounting_webhook_events WHERE provider = 'xero'"
      ).first<{ count: number }>();
      assert.strictEqual(countRow?.count, 1, 'Exactly 1 event must be recorded in accounting_webhook_events');

      // Check external provider sync was called exactly ONCE
      assert.strictEqual(syncSingleInvoiceCalls, 1, 'Sync API must be called exactly once despite 50 replays');

      // Check invoice table has exactly 1 invoice
      const invoiceCount = await db.prepare(
        'SELECT COUNT(*) as count FROM invoices WHERE client_id = 10'
      ).first<{ count: number }>();
      assert.strictEqual(invoiceCount?.count, 1);
    });

    test('QuickBooks: 50 sequential replays of identical event trigger DB side-effect exactly once', async () => {
      const { env, db } = createTestEnv({
        QUICKBOOKS_VERIFIER_TOKEN: qbSecret,
        TOKEN_ENCRYPTION_SECRET: 'secret-key-32-chars-long-test-123!',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (20, 'Dedup QB Client', 'qbdedup@test.com', 'engine', 'active', 'quickbooks');
      `);

      const encToken = await encryptToken('mock-qb-access', 'secret-key-32-chars-long-test-123!');
      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (20, 'quickbooks', 'realm-dedup-qb', ?1, ?1, '2026-09-17T00:00:00Z', 'active')
      `).bind(encToken).run();

      let qbFetchCalls = 0;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url.includes('/company/realm-dedup-qb/invoice/')) {
          qbFetchCalls++;
          return new Response(JSON.stringify({
            Invoice: {
              Id: 'qb-inv-999',
              DocNumber: 'INV-QB-999',
              CustomerRef: { name: 'QB Debtor' },
              Balance: 500.0,
              TotalAmt: 500.0,
              DueDate: '2026-08-15',
            }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      };

      const payload = JSON.stringify({
        eventNotifications: [{
          realmId: 'realm-dedup-qb',
          dataChangeEvent: {
            entities: [{
              name: 'Invoice',
              id: 'qb-inv-999',
              operation: 'Update',
              lastUpdated: '2026-09-16T05:15:00.000Z',
            }],
          },
        }],
      });

      const signature = await signHmacSha256(payload, qbSecret);

      for (let i = 0; i < 50; i++) {
        const req = new Request('http://localhost/api/webhooks/quickbooks', {
          method: 'POST',
          headers: {
            'intuit-signature': signature,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        const res = await worker.fetch(req, env);
        assert.strictEqual(res.status, 200);
      }

      const countRow = await db.prepare(
        "SELECT COUNT(*) as count FROM accounting_webhook_events WHERE provider = 'quickbooks'"
      ).first<{ count: number }>();
      assert.strictEqual(countRow?.count, 1);
      assert.strictEqual(qbFetchCalls, 1, 'QuickBooks fetch must only occur once across 50 replays');
    });

    test('Direct recordAccountingWebhook: Replay with different payload rejects duplicate ID', async () => {
      const { env, db } = createTestEnv();

      // First insert
      const first = await recordAccountingWebhook(env.DB, 'evt_unique_1', 'xero', { amount: 100 });
      assert.strictEqual(first, true);

      // Replay with identical payload
      const second = await recordAccountingWebhook(env.DB, 'evt_unique_1', 'xero', { amount: 100 });
      assert.strictEqual(second, false);

      // Replay with maliciously altered payload
      const third = await recordAccountingWebhook(env.DB, 'evt_unique_1', 'xero', { amount: 999999 });
      assert.strictEqual(third, false);

      // Verify original payload remains intact in DB
      const row = await db.prepare(
        'SELECT payload FROM accounting_webhook_events WHERE id = ?1'
      ).bind('evt_unique_1').first<{ payload: string }>();
      assert.ok(row);
      assert.strictEqual(JSON.parse(row.payload).amount, 100);
    });

    test('recordAccountingWebhook rejects invalid event IDs and unsupported providers', async () => {
      const { env } = createTestEnv();

      await assert.rejects(
        async () => recordAccountingWebhook(env.DB, '', 'xero', {}),
        InvalidWebhookEventError
      );

      await assert.rejects(
        async () => recordAccountingWebhook(env.DB, 'evt_1', 'stripe' as any, {}),
        InvalidWebhookEventError
      );
    });
  });

  // =========================================================================
  // SUITE 3: Invoice Settlement & Immediate Draft Cancellation
  // =========================================================================
  describe('3. Invoice Settlement & Immediate Chase Draft Cancellation', () => {
    test('Reconcile as paid immediately sets pending drafts to skipped while preserving sent/approved', async () => {
      const { env, db } = createTestEnv();

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (5, 'Settlement Client', 'settle@test.com', 'engine', 'active');

        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (50, 5, 'Debtor Multi Draft', 'INV-SETTLE-50', 85000, '2026-08-01', 'overdue');

        -- 3 pending drafts
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (501, 50, 1, 'email', 'draft', 'Draft 1 message');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (502, 50, 2, 'email', 'draft', 'Draft 2 message');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (503, 50, 3, 'email', 'draft', 'Draft 3 message');

        -- 1 already skipped chase
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body, reviewed_at)
        VALUES (504, 50, 1, 'email', 'skipped', 'Previously skipped message', '2026-09-10T10:00:00Z');

        -- 1 already sent chase
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body, outcome)
        VALUES (505, 50, 1, 'email', 'sent', 'Sent message', 'sent');
      `);

      const syncService = new SyncService(env.DB, env);

      const settledNorm: NormalizedInvoice = {
        externalId: 'ext-settle-50',
        invoiceNumber: 'INV-SETTLE-50',
        debtorName: 'Debtor Multi Draft',
        debtorEmail: null,
        amountPence: 85000,
        currency: 'GBP',
        dueDate: '2026-08-01',
        issuedDate: '2026-07-01',
        isPaid: true,
        paidDate: '2026-09-16',
        isDisputedOrVoid: false,
      };

      const outcome = await syncService.reconcileInvoice(5, settledNorm);
      assert.strictEqual(outcome, 'marked_paid');

      // Verify invoice status
      const inv = await db.prepare('SELECT status, paid_date FROM invoices WHERE id = 50').first<any>();
      assert.strictEqual(inv.status, 'paid');
      assert.strictEqual(inv.paid_date, '2026-09-16');

      // Verify drafts 501, 502, 503 are all transitioned to 'skipped' with reviewed_at
      const drafts = await db.prepare(
        'SELECT id, status, reviewed_at FROM chase_log WHERE id IN (501, 502, 503)'
      ).all<any>();

      assert.strictEqual(drafts.results.length, 3);
      for (const d of drafts.results) {
        assert.strictEqual(d.status, 'skipped', `Draft ${d.id} must be transitioned to skipped`);
        assert.ok(d.reviewed_at, `Draft ${d.id} must have reviewed_at populated`);
      }

      // CRITICAL: Previously skipped and sent drafts must NOT be overwritten
      const skippedChase = await db.prepare('SELECT status, reviewed_at FROM chase_log WHERE id = 504').first<any>();
      assert.strictEqual(skippedChase.status, 'skipped');
      assert.strictEqual(skippedChase.reviewed_at, '2026-09-10T10:00:00Z', 'Previously skipped draft reviewed_at must not be overwritten');

      const sentChase = await db.prepare('SELECT status, outcome FROM chase_log WHERE id = 505').first<any>();
      assert.strictEqual(sentChase.status, 'sent', 'Already sent chase must not be overwritten');
      assert.strictEqual(sentChase.outcome, 'sent');
    });

    test('Webhook invoice payment sync cancels draft in chase_log end-to-end', async () => {
      const xeroSecret = 'webhook_settle_secret_key';
      const { env, db } = createTestEnv({
        XERO_WEBHOOK_KEY: xeroSecret,
        TOKEN_ENCRYPTION_SECRET: 'secret-key-32-chars-long-test-123!',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (6, 'Webhook Client', 'whc@test.com', 'engine', 'active', 'xero');

        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status, external_id)
        VALUES (60, 6, 'Debtor WH', 'INV-WH-60', 120000, '2026-08-01', 'overdue', 'xero-res-60');

        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (601, 60, 2, 'email', 'draft', 'Firm notice draft');
      `);

      const encToken = await encryptToken('mock-xero-access', 'secret-key-32-chars-long-test-123!');
      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (6, 'xero', 'tenant-xero-wh-6', ?1, ?1, '2026-09-17T00:00:00Z', 'active')
      `).bind(encToken).run();

      // Mock Xero single invoice fetch returning PAID
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url.includes('/api.xro/2.0/Invoices/xero-res-60')) {
          return new Response(JSON.stringify({
            Invoices: [{
              InvoiceID: 'xero-res-60',
              InvoiceNumber: 'INV-WH-60',
              Contact: { Name: 'Debtor WH' },
              AmountDue: 0.0,
              Total: 1200.0,
              Status: 'PAID',
              DueDateString: '2026-08-01',
              FullyPaidOnDate: '2026-09-16',
            }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      };

      const payload = JSON.stringify({
        events: [{
          resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/xero-res-60',
          resourceId: 'xero-res-60',
          eventDateUtc: '2026-09-16T05:40:00.000Z',
          eventType: 'UPDATE',
          eventCategory: 'INVOICE',
          tenantId: 'tenant-xero-wh-6',
        }],
        firstEventSequence: 1,
        lastEventSequence: 1,
      });

      const signature = await signHmacSha256(payload, xeroSecret);

      const req = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': signature,
          'Content-Type': 'application/json',
        },
        body: payload,
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      // Verify draft 601 was cancelled to 'skipped'
      const draft = await db.prepare('SELECT status, reviewed_at FROM chase_log WHERE id = 601').first<any>();
      assert.strictEqual(draft.status, 'skipped');
      assert.ok(draft.reviewed_at);

      // Verify invoice marked paid
      const invoice = await db.prepare('SELECT status, paid_date FROM invoices WHERE id = 60').first<any>();
      assert.strictEqual(invoice.status, 'paid');
      assert.strictEqual(invoice.paid_date, '2026-09-16');
    });

    test('Non-downgrade invariant: Subsequent sync claiming overdue NEVER reverts paid status', async () => {
      const { env, db } = createTestEnv();

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (7, 'Non Downgrade Client', 'nd@test.com', 'engine', 'active');

        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status, paid_date)
        VALUES (70, 7, 'Debtor Settled', 'INV-PAID-IMMUTABLE', 40000, '2026-08-01', 'paid', '2026-09-10');
      `);

      const syncService = new SyncService(env.DB, env);

      // Out-of-order or stale sync payload claims invoice is unpaid/overdue
      const staleOverdueNorm: NormalizedInvoice = {
        externalId: 'ext-70',
        invoiceNumber: 'INV-PAID-IMMUTABLE',
        debtorName: 'Debtor Settled',
        debtorEmail: null,
        amountPence: 40000,
        currency: 'GBP',
        dueDate: '2026-08-01',
        issuedDate: '2026-07-01',
        isPaid: false,
        paidDate: null,
        isDisputedOrVoid: false,
      };

      const outcome = await syncService.reconcileInvoice(7, staleOverdueNorm);
      assert.strictEqual(outcome, 'unchanged');

      // Verify invoice status remains 'paid' and paid_date is unchanged
      const inv = await db.prepare('SELECT status, paid_date FROM invoices WHERE id = 70').first<any>();
      assert.strictEqual(inv.status, 'paid');
      assert.strictEqual(inv.paid_date, '2026-09-10');
    });

    test('Voided or disputed invoices immediately cancel pending drafts in chase_log', async () => {
      const { env, db } = createTestEnv();

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (8, 'Dispute Client', 'disp@test.com', 'engine', 'active');

        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (80, 8, 'Debtor Dispute', 'INV-DISP-80', 75000, '2026-08-01', 'overdue');

        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (801, 80, 1, 'email', 'draft', 'Draft for disputed invoice');
      `);

      const syncService = new SyncService(env.DB, env);

      const voidNorm: NormalizedInvoice = {
        externalId: 'ext-void-80',
        invoiceNumber: 'INV-DISP-80',
        debtorName: 'Debtor Dispute',
        debtorEmail: null,
        amountPence: 75000,
        currency: 'GBP',
        dueDate: '2026-08-01',
        issuedDate: '2026-07-01',
        isPaid: false,
        paidDate: null,
        isDisputedOrVoid: true,
      };

      const outcome = await syncService.reconcileInvoice(8, voidNorm);
      assert.strictEqual(outcome, 'updated');

      const inv = await db.prepare('SELECT status FROM invoices WHERE id = 80').first<any>();
      assert.strictEqual(inv.status, 'disputed');

      const draft = await db.prepare('SELECT status, reviewed_at FROM chase_log WHERE id = 801').first<any>();
      assert.strictEqual(draft.status, 'skipped');
      assert.ok(draft.reviewed_at);
    });
  });

  // =========================================================================
  // SUITE 4: Expired OAuth Tokens & Automatic Refresh
  // =========================================================================
  describe('4. OAuth 2.0 Token Expiration & Automatic Refresh Lifecycle', () => {
    test('SyncService automatically calls refreshProviderTokens when token is expired (past date)', async () => {
      const secret = 'test-token-secret-at-least-32-chars!';
      const { env, db } = createTestEnv({
        TOKEN_ENCRYPTION_SECRET: secret,
        XERO_CLIENT_ID: 'test_xero_client_id',
        XERO_CLIENT_SECRET: 'test_xero_client_secret',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (11, 'Refresh Expired Client', 'rec@test.com', 'engine', 'active', 'xero');
      `);

      const encOldAccess = await encryptToken('expired-access-token-11', secret);
      const encOldRefresh = await encryptToken('old-refresh-token-11', secret);

      // Expired 1 hour ago
      const expiredTimestamp = new Date(Date.now() - 3600 * 1000).toISOString();

      await db.prepare(`
        INSERT INTO accounting_connections (
          client_id, provider, tenant_id, access_token_encrypted,
          refresh_token_encrypted, expires_at, status
        ) VALUES (11, 'xero', 'tenant-refresh-11', ?1, ?2, ?3, 'active')
      `).bind(encOldAccess, encOldRefresh, expiredTimestamp).run();

      let refreshEndpointCalled = false;
      let syncFetchCalled = false;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input.toString();

        if (url === 'https://identity.xero.com/connect/token') {
          refreshEndpointCalled = true;
          const body = init?.body?.toString() ?? '';
          assert.ok(body.includes('grant_type=refresh_token'));
          assert.ok(body.includes('refresh_token=old-refresh-token-11'));

          return new Response(JSON.stringify({
            access_token: 'freshly-refreshed-access-token-11',
            refresh_token: 'freshly-refreshed-refresh-token-11',
            expires_in: 3600,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.includes('/api.xro/2.0/Invoices')) {
          syncFetchCalled = true;
          // Verify that invoices fetch uses the NEW access token!
          const authHeader = (init?.headers as any)?.Authorization || (init?.headers as any)?.authorization;
          assert.strictEqual(authHeader, 'Bearer freshly-refreshed-access-token-11');

          return new Response(JSON.stringify({ Invoices: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response('Not Found', { status: 404 });
      };

      const syncService = new SyncService(env.DB, env);
      const syncResult = await syncService.syncInvoices(11);

      assert.strictEqual(syncResult.success, true);
      assert.strictEqual(refreshEndpointCalled, true, 'refreshProviderTokens must be invoked for expired token');
      assert.strictEqual(syncFetchCalled, true, 'Sync must continue using newly refreshed access token');

      // Verify connection in D1 was updated with new encrypted tokens and future expiration
      const updatedConn = await db.prepare(
        'SELECT access_token_encrypted, refresh_token_encrypted, expires_at, status FROM accounting_connections WHERE client_id = 11'
      ).first<any>();

      assert.ok(updatedConn);
      assert.strictEqual(updatedConn.status, 'active');

      const decryptedAccess = await decryptToken(updatedConn.access_token_encrypted, secret);
      assert.strictEqual(decryptedAccess, 'freshly-refreshed-access-token-11');

      const decryptedRefresh = await decryptToken(updatedConn.refresh_token_encrypted, secret);
      assert.strictEqual(decryptedRefresh, 'freshly-refreshed-refresh-token-11');

      const newExpiresMs = new Date(updatedConn.expires_at).getTime();
      assert.ok(newExpiresMs > Date.now() + 3000 * 1000, 'New expires_at must be ~1 hour in the future');
    });

    test('SyncService automatically refreshes token when expiring within 5-minute safety threshold', async () => {
      const secret = 'test-token-secret-at-least-32-chars!';
      const { env, db } = createTestEnv({
        TOKEN_ENCRYPTION_SECRET: secret,
        QUICKBOOKS_CLIENT_ID: 'qb_client_id_test',
        QUICKBOOKS_CLIENT_SECRET: 'qb_client_secret_test',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (12, 'Near Expiry Client', 'near@test.com', 'engine', 'active', 'quickbooks');
      `);

      const encOldAccess = await encryptToken('near-expiry-access-12', secret);
      const encOldRefresh = await encryptToken('near-expiry-refresh-12', secret);

      // Expiring in 2 minutes (within the 5-minute window)
      const nearExpiryTimestamp = new Date(Date.now() + 120 * 1000).toISOString();

      await db.prepare(`
        INSERT INTO accounting_connections (
          client_id, provider, tenant_id, access_token_encrypted,
          refresh_token_encrypted, expires_at, status
        ) VALUES (12, 'quickbooks', 'realm-12', ?1, ?2, ?3, 'active')
      `).bind(encOldAccess, encOldRefresh, nearExpiryTimestamp).run();

      let qbRefreshCalled = false;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = input.toString();

        if (url === 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer') {
          qbRefreshCalled = true;
          return new Response(JSON.stringify({
            access_token: 'fresh-qb-access-token-12',
            refresh_token: 'fresh-qb-refresh-token-12',
            expires_in: 3600,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.includes('/query')) {
          return new Response(JSON.stringify({ QueryResponse: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response('Not Found', { status: 404 });
      };

      const syncService = new SyncService(env.DB, env);
      const result = await syncService.syncInvoices(12);

      assert.strictEqual(result.success, true);
      assert.strictEqual(qbRefreshCalled, true, 'Token expiring in 2 min must trigger automatic refresh');
    });

    test('SyncService DOES NOT refresh token when token is comfortably fresh (> 5 min)', async () => {
      const secret = 'test-token-secret-at-least-32-chars!';
      const { env, db } = createTestEnv({
        TOKEN_ENCRYPTION_SECRET: secret,
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (13, 'Fresh Token Client', 'fresh@test.com', 'engine', 'active', 'xero');
      `);

      const encAccess = await encryptToken('fresh-access-token-13', secret);
      const encRefresh = await encryptToken('fresh-refresh-token-13', secret);

      // Expiring in 2 hours
      const freshTimestamp = new Date(Date.now() + 7200 * 1000).toISOString();

      await db.prepare(`
        INSERT INTO accounting_connections (
          client_id, provider, tenant_id, access_token_encrypted,
          refresh_token_encrypted, expires_at, status
        ) VALUES (13, 'xero', 'tenant-fresh-13', ?1, ?2, ?3, 'active')
      `).bind(encAccess, encRefresh, freshTimestamp).run();

      let refreshEndpointCalled = false;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url === 'https://identity.xero.com/connect/token') {
          refreshEndpointCalled = true;
          return new Response('{}', { status: 200 });
        }
        if (url.includes('/api.xro/2.0/Invoices')) {
          return new Response(JSON.stringify({ Invoices: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      };

      const syncService = new SyncService(env.DB, env);
      const result = await syncService.syncInvoices(13);

      assert.strictEqual(result.success, true);
      assert.strictEqual(refreshEndpointCalled, false, 'Fresh token (> 5 min) must NOT trigger refresh');
    });

    test('SyncService handles invalid_grant on refresh by transitioning connection status to revoked', async () => {
      const secret = 'test-token-secret-at-least-32-chars!';
      const { env, db } = createTestEnv({
        TOKEN_ENCRYPTION_SECRET: secret,
        XERO_CLIENT_ID: 'test_xero_id',
        XERO_CLIENT_SECRET: 'test_xero_secret',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (14, 'Revoked Client', 'rev@test.com', 'engine', 'active', 'xero');
      `);

      const encAccess = await encryptToken('expired-access-14', secret);
      const encRefresh = await encryptToken('revoked-refresh-14', secret);
      const expiredTimestamp = new Date(Date.now() - 3600 * 1000).toISOString();

      await db.prepare(`
        INSERT INTO accounting_connections (
          client_id, provider, tenant_id, access_token_encrypted,
          refresh_token_encrypted, expires_at, status
        ) VALUES (14, 'xero', 'tenant-14', ?1, ?2, ?3, 'active')
      `).bind(encAccess, encRefresh, expiredTimestamp).run();

      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url === 'https://identity.xero.com/connect/token') {
          return new Response(JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been revoked or expired',
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      };

      const syncService = new SyncService(env.DB, env);
      const result = await syncService.syncInvoices(14);

      // Must fail cleanly
      assert.strictEqual(result.success, false);
      assert.ok(result.reason?.includes('revoked') || result.reason?.includes('fresh access token'));

      // Connection status in D1 must be updated to 'revoked'
      const conn = await db.prepare(
        'SELECT status FROM accounting_connections WHERE client_id = 14'
      ).first<any>();
      assert.strictEqual(conn.status, 'revoked', 'Connection status must transition to revoked on invalid_grant');
    });

    test('POST /api/oauth/:provider/refresh endpoint updates connection and handles revoked grants', async () => {
      const secret = 'test-token-secret-at-least-32-chars!';
      const { env, db } = createTestEnv({
        PORTAL_SESSION_SECRET: secret,
        XERO_CLIENT_ID: 'xero_id',
        XERO_CLIENT_SECRET: 'xero_secret',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (15, 'Manual Refresh Client', 'mrc@test.com', 'engine', 'active');
      `);

      const encAccess = await encryptToken('access-15', secret);
      const encRefresh = await encryptToken('refresh-15', secret);

      await db.prepare(`
        INSERT INTO accounting_connections (
          client_id, provider, tenant_id, access_token_encrypted,
          refresh_token_encrypted, expires_at, status
        ) VALUES (15, 'xero', 'tenant-15', ?1, ?2, '2026-09-16T00:00:00Z', 'active')
      `).bind(encAccess, encRefresh).run();

      const sessionCookie = await buildSessionCookie(15, secret);

      // Mock upstream returning invalid_grant
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url === 'https://identity.xero.com/connect/token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const req = new Request('http://localhost/api/oauth/xero/refresh', {
        method: 'POST',
        headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401, 'Endpoint must return 401 when refresh token is revoked');

      const conn = await db.prepare('SELECT status FROM accounting_connections WHERE client_id = 15').first<any>();
      assert.strictEqual(conn.status, 'revoked');
    });
  });

  // =========================================================================
  // SUITE 5: Cryptographic Integrity, Concurrency & Multi-Tenant Isolation
  // =========================================================================
  describe('5. Cryptographic Integrity, Concurrency & Multi-Tenant Isolation', () => {
    test('AES-GCM: 50 encryptions of identical token generate 50 unique IVs and ciphertexts', async () => {
      const secret = 'cryptographic-master-key-32-bytes-minimum!';
      const token = 'my-static-oauth-bearer-token-12345';
      const ciphertexts = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const encrypted = await encryptToken(token, secret);
        assert.ok(encrypted.length > 20);
        ciphertexts.add(encrypted);

        const decrypted = await decryptToken(encrypted, secret);
        assert.strictEqual(decrypted, token);
      }

      // If IV is reused, ciphertexts would collide!
      assert.strictEqual(ciphertexts.size, 50, 'AES-GCM must never reuse an IV across encryptions');
    });

    test('AES-GCM: Decryption fails closed upon wrong key or tampered ciphertext', async () => {
      const keyA = 'key-a-at-least-32-chars-long-1234567!';
      const keyB = 'key-b-at-least-32-chars-long-7654321!';
      const plaintext = 'confidential-token-material';

      const encrypted = await encryptToken(plaintext, keyA);

      // Wrong key
      await assert.rejects(
        async () => decryptToken(encrypted, keyB),
        'Decrypting with wrong key must fail closed'
      );

      // Tampered ciphertext (flip 1 character)
      const tampered = encrypted.slice(0, 15) + (encrypted[15] === 'A' ? 'B' : 'A') + encrypted.slice(16);
      await assert.rejects(
        async () => decryptToken(tampered, keyA),
        'Decrypting tampered ciphertext must fail closed'
      );
    });

    test('Webhook Concurrency: 20 parallel requests for same event produce exactly 1 DB side-effect', async () => {
      const xeroSecret = 'parallel-webhook-key-123';
      const { env, db } = createTestEnv({
        XERO_WEBHOOK_KEY: xeroSecret,
        TOKEN_ENCRYPTION_SECRET: 'test-secret-at-least-32-chars!',
      } as any);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status, accounting_source)
        VALUES (30, 'Parallel Client', 'parallel@test.com', 'engine', 'active', 'xero');
      `);

      const encToken = await encryptToken('mock-xero-access', 'test-secret-at-least-32-chars!');
      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (30, 'xero', 'tenant-parallel', ?1, ?1, '2026-09-17T00:00:00Z', 'active')
      `).bind(encToken).run();

      let parallelSyncCalls = 0;
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        const url = input.toString();
        if (url.includes('/api.xro/2.0/Invoices/')) {
          parallelSyncCalls++;
          return new Response(JSON.stringify({
            Invoices: [{
              InvoiceID: 'inv-parallel-1',
              InvoiceNumber: 'INV-PARALLEL-1',
              Contact: { Name: 'Parallel Debtor' },
              AmountDue: 1000.0,
              Total: 1000.0,
              Status: 'AUTHORISED',
              DueDateString: '2026-08-20',
            }]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('Not Found', { status: 404 });
      };

      const payload = JSON.stringify({
        events: [{
          resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices/inv-parallel-1',
          resourceId: 'inv-parallel-1',
          eventDateUtc: '2026-09-16T05:50:00.000Z',
          eventType: 'UPDATE',
          eventCategory: 'INVOICE',
          tenantId: 'tenant-parallel',
        }],
        firstEventSequence: 1,
        lastEventSequence: 1,
      });

      const signature = await signHmacSha256(payload, xeroSecret);

      // Launch 20 concurrent requests
      const promises = Array.from({ length: 20 }).map(() => {
        const req = new Request('http://localhost/api/webhooks/xero', {
          method: 'POST',
          headers: {
            'x-xero-signature': signature,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        return worker.fetch(req, env);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      // DB must contain exactly 1 event
      const eventRows = await db.prepare(
        "SELECT COUNT(*) as count FROM accounting_webhook_events WHERE provider = 'xero' AND id LIKE '%inv-parallel-1%'"
      ).first<{ count: number }>();
      assert.strictEqual(eventRows?.count, 1);

      // Sync must only have been invoked once
      assert.strictEqual(parallelSyncCalls, 1, 'Sync API must be called exactly once despite 20 concurrent requests');
    });

    test('Cross-Tenant Sync Isolation: Concurrent sync with identical invoice numbers across tenants', async () => {
      const { env, db } = createTestEnv();

      // Tenant 100 and Tenant 200 both have invoice "INV-SHARED-1"
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (100, 'Tenant 100', 't100@test.com', 'engine', 'active'),
               (200, 'Tenant 200', 't200@test.com', 'engine', 'active');

        -- Tenant 100 invoice is settled (£1,000 paid)
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status, paid_date)
        VALUES (1001, 100, 'Debtor 100', 'INV-SHARED-1', 100000, '2026-08-01', 'paid', '2026-09-01');

        -- Tenant 200 invoice is overdue (£500 unpaid)
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (2001, 200, 'Debtor 200', 'INV-SHARED-1', 50000, '2026-08-05', 'overdue');
      `);

      const syncService = new SyncService(env.DB, env);

      // Sync comes in for Tenant 200 updating amount to £550
      const norm200: NormalizedInvoice = {
        externalId: 'ext-2001',
        invoiceNumber: 'INV-SHARED-1',
        debtorName: 'Debtor 200 Updated',
        debtorEmail: 'debtor200@test.com',
        amountPence: 55000,
        currency: 'GBP',
        dueDate: '2026-08-05',
        issuedDate: '2026-07-05',
        isPaid: false,
        paidDate: null,
        isDisputedOrVoid: false,
      };

      const outcome = await syncService.reconcileInvoice(200, norm200);
      assert.strictEqual(outcome, 'updated');

      // Tenant 200 invoice must be updated
      const inv200 = await db.prepare('SELECT amount_pence, status FROM invoices WHERE id = 2001').first<any>();
      assert.strictEqual(inv200.amount_pence, 55000);
      assert.strictEqual(inv200.status, 'overdue');

      // CRITICAL: Tenant 100 invoice must NOT be modified in any way!
      const inv100 = await db.prepare('SELECT amount_pence, status, paid_date FROM invoices WHERE id = 1001').first<any>();
      assert.strictEqual(inv100.amount_pence, 100000, 'Tenant 100 amount must remain unchanged');
      assert.strictEqual(inv100.status, 'paid', 'Tenant 100 status must remain paid');
      assert.strictEqual(inv100.paid_date, '2026-09-01');
    });

    test('OAuth callback gracefully handles provider error params (e.g. user denied)', async () => {
      const { env } = createTestEnv();

      const req = new Request(
        'http://localhost/api/oauth/xero/callback?error=access_denied&error_description=The+user+cancelled+the+request'
      );
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 400);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.ok(json.error.includes('The user cancelled the request'));
    });

    test('OAuth callback rejects missing authorization code', async () => {
      const { env } = createTestEnv();

      const req = new Request('http://localhost/api/oauth/xero/callback?state=some_state');
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 400);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.strictEqual(json.error, 'Missing authorization code.');
    });
  });
});
