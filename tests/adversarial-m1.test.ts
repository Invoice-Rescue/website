import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './e2e/harness';
import worker from '../backend/src/index';
import {
  getTenantInvoices,
  getTenantInvoiceByNumber,
  getTenantInvoiceById,
  upsertTenantInvoice,
  recordAccountingWebhook,
  getAccountingConnection,
  upsertAccountingConnection,
  resolveClientByAccountingTenant,
  approveTenantDraft,
  skipTenantDraft,
  TenantRepository,
  InvalidTenantError,
  InvalidInvoiceDataError,
  InvalidWebhookEventError,
  InvalidInputError,
} from '../backend/src/lib/tenant-repo';
import { SyncService, NormalizedInvoice } from '../backend/src/lib/integrations/sync-service';
import { buildSessionCookie } from '../backend/src/lib/portal-auth';
import { encryptToken, generateOAuthState, verifyOAuthState } from '../backend/src/lib/integrations/oauth-manager';
import { signHmacSha256 } from './e2e/harness';

describe('Adversarial Challenge Suite: Milestone M1 (Multi-Tenant Data Architecture)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function seedMultipleClients(db: any, count = 10) {
    const values = [];
    for (let i = 1; i <= count; i++) {
      values.push(`(${i}, 'Company ${i}', 'client${i}@test.com', 'engine', 'active')`);
    }
    db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES ${values.join(', ')};
    `);
  }

  // =========================================================================
  // Dimension 1: Strict Multi-Tenant Isolation & Boundary Protections
  // =========================================================================
  describe('Dimension 1: Tenant Isolation & Boundary Protections', () => {
    test('Client A cannot read Client B invoices via any repository method', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 3);
      const d1 = db as unknown as D1Database;

      // Seed invoices for Client 1 and Client 2
      await upsertTenantInvoice(d1, 1, {
        debtorName: 'Debtor Alpha',
        invoiceNumber: 'INV-A-101',
        amountPence: 10000,
        dueDate: '2026-08-01',
      });

      await upsertTenantInvoice(d1, 2, {
        debtorName: 'Debtor Beta Secret',
        invoiceNumber: 'INV-B-202',
        amountPence: 200000,
        dueDate: '2026-08-02',
      });

      // 1. getTenantInvoices
      const client1Invoices = await getTenantInvoices(d1, 1);
      assert.strictEqual(client1Invoices.length, 1);
      assert.strictEqual(client1Invoices[0].invoiceNumber, 'INV-A-101');
      assert.ok(!client1Invoices.some(i => i.invoiceNumber === 'INV-B-202'));

      // 2. getTenantInvoiceByNumber: Client 1 querying Client 2's invoice number returns null
      const crossReadByNumber = await getTenantInvoiceByNumber(d1, 1, 'INV-B-202');
      assert.strictEqual(crossReadByNumber, null);

      // 3. getTenantInvoiceById: Client 1 querying Client 2's invoice ID returns null
      const client2Invoices = await getTenantInvoices(d1, 2);
      const client2InvId = client2Invoices[0].id;

      const crossReadById = await getTenantInvoiceById(d1, 1, client2InvId);
      assert.strictEqual(crossReadById, null);

      // 4. Object-Oriented TenantRepository scoping
      const repo1 = new TenantRepository(d1, 1);
      assert.strictEqual((await repo1.getInvoices()).length, 1);
      assert.strictEqual(await repo1.getInvoiceByNumber('INV-B-202'), null);
      assert.strictEqual(await repo1.getInvoiceById(client2InvId), null);
    });

    test('Client A cannot mutate, overwrite, or corrupt Client B invoice data', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 2);
      const d1 = db as unknown as D1Database;

      // Client 2 creates high-value invoice
      await upsertTenantInvoice(d1, 2, {
        debtorName: 'Client 2 Debtor',
        invoiceNumber: 'INV-SHARED-KEY',
        amountPence: 5000000, // £50,000
        dueDate: '2026-08-10',
      });

      // Client 1 attempts to insert or overwrite using same invoice number with small amount
      const res1 = await upsertTenantInvoice(d1, 1, {
        debtorName: 'Client 1 Debtor',
        invoiceNumber: 'INV-SHARED-KEY',
        amountPence: 100, // £1
        dueDate: '2026-08-10',
      });
      assert.strictEqual(res1.action, 'inserted');

      // Verify Client 2's invoice is completely unchanged and uncorrupted
      const client2Inv = await getTenantInvoiceByNumber(d1, 2, 'INV-SHARED-KEY');
      assert.ok(client2Inv);
      assert.strictEqual(client2Inv.amountPence, 5000000);
      assert.strictEqual(client2Inv.debtorName, 'Client 2 Debtor');

      // Verify Client 1's invoice exists distinctly
      const client1Inv = await getTenantInvoiceByNumber(d1, 1, 'INV-SHARED-KEY');
      assert.ok(client1Inv);
      assert.strictEqual(client1Inv.amountPence, 100);
      assert.strictEqual(client1Inv.debtorName, 'Client 1 Debtor');
      assert.notStrictEqual(client1Inv.id, client2Inv.id);
    });

    test('Cross-tenant draft approval and skipping are strictly rejected', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 2);
      const d1 = db as unknown as D1Database;

      await upsertTenantInvoice(d1, 1, {
        debtorName: 'Debtor 1',
        invoiceNumber: 'INV-DRAFT-1',
        amountPence: 15000,
        dueDate: '2026-08-01',
      });
      const inv1 = (await getTenantInvoiceByNumber(d1, 1, 'INV-DRAFT-1'))!;

      // Insert draft chase belonging to Client 1
      db.rawSqlite.exec(`
        INSERT INTO chase_log (invoice_id, step, channel, status, body, subject)
        VALUES (${inv1.id}, 1, 'email', 'draft', 'Original draft', 'Subject 1');
      `);
      const draftId = Number(db.rawSqlite.prepare('SELECT id FROM chase_log WHERE invoice_id = ?').get(inv1.id)?.id);

      // Client 2 attempts to approve Client 1's draft
      const approvedByOther = await approveTenantDraft(d1, 2, draftId, 'Tampered Body', 'Attacker');
      assert.strictEqual(approvedByOther, false);

      // Verify draft was NOT modified
      const draftRow = db.rawSqlite.prepare('SELECT body, status, reviewed_by FROM chase_log WHERE id = ?').get(draftId) as any;
      assert.strictEqual(draftRow.status, 'draft');
      assert.strictEqual(draftRow.body, 'Original draft');
      assert.strictEqual(draftRow.reviewed_by, null);

      // Client 2 attempts to skip Client 1's draft
      const skippedByOther = await skipTenantDraft(d1, 2, draftId);
      assert.strictEqual(skippedByOther, false);
      const draftRow2 = db.rawSqlite.prepare('SELECT status FROM chase_log WHERE id = ?').get(draftId) as any;
      assert.strictEqual(draftRow2.status, 'draft');

      // Client 1 approves legitimately
      const approvedByOwner = await approveTenantDraft(d1, 1, draftId, 'Owner Body', 'Owner Name');
      assert.strictEqual(approvedByOwner, true);
      const finalDraft = db.rawSqlite.prepare('SELECT status, body, reviewed_by FROM chase_log WHERE id = ?').get(draftId) as any;
      assert.strictEqual(finalDraft.status, 'sent');
      assert.strictEqual(finalDraft.body, 'Owner Body');
      assert.strictEqual(finalDraft.reviewed_by, 'Owner Name');
    });

    test('Fuzzing & Injection Defense: validateClientId rejects non-positive and non-integer types', async () => {
      const db = createTestDb();
      const d1 = db as unknown as D1Database;

      const maliciousClientIds = [
        "1 OR 1=1",
        "1; DROP TABLE invoices; --",
        "' UNION SELECT * FROM invoices --",
        0,
        -1,
        -999999,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        null,
        undefined,
        true,
        false,
        {},
        [],
        [1],
      ];

      for (const badId of maliciousClientIds) {
        await assert.rejects(
          async () => getTenantInvoices(d1, badId as any),
          InvalidTenantError,
          `Failed to reject bad clientId: ${String(badId)}`
        );
        await assert.rejects(
          async () => getTenantInvoiceByNumber(d1, badId as any, 'INV-1'),
          InvalidTenantError,
          `Failed to reject bad clientId: ${String(badId)}`
        );
        await assert.rejects(
          async () => getTenantInvoiceById(d1, badId as any, 1),
          InvalidTenantError,
          `Failed to reject bad clientId: ${String(badId)}`
        );
        await assert.rejects(
          async () => upsertTenantInvoice(d1, badId as any, {
            debtorName: 'Debtor',
            invoiceNumber: 'INV-1',
            amountPence: 1000,
            dueDate: '2026-08-01',
          }),
          InvalidTenantError,
          `Failed to reject bad clientId: ${String(badId)}`
        );
      }
    });

    test('Accounting connection isolation across tenants', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 3);
      const d1 = db as unknown as D1Database;

      await upsertAccountingConnection(d1, 1, {
        provider: 'xero',
        tenantId: 'xero-tenant-alpha',
        accessTokenEncrypted: 'enc_token_client_1',
        refreshTokenEncrypted: 'enc_ref_client_1',
        expiresAt: '2026-10-01T00:00:00Z',
        status: 'active',
      });

      await upsertAccountingConnection(d1, 2, {
        provider: 'xero',
        tenantId: 'xero-tenant-beta',
        accessTokenEncrypted: 'enc_token_client_2',
        refreshTokenEncrypted: 'enc_ref_client_2',
        expiresAt: '2026-10-01T00:00:00Z',
        status: 'active',
      });

      // Tenant 1 only sees their connection
      const conn1 = await getAccountingConnection(d1, 1, 'xero');
      assert.ok(conn1);
      assert.strictEqual(conn1.tenantId, 'xero-tenant-alpha');
      assert.strictEqual(conn1.accessTokenEncrypted, 'enc_token_client_1');

      // Tenant 2 only sees their connection
      const conn2 = await getAccountingConnection(d1, 2, 'xero');
      assert.ok(conn2);
      assert.strictEqual(conn2.tenantId, 'xero-tenant-beta');
      assert.strictEqual(conn2.accessTokenEncrypted, 'enc_token_client_2');

      // Tenant 3 has no connection
      const conn3 = await getAccountingConnection(d1, 3, 'xero');
      assert.strictEqual(conn3, null);

      // External tenant resolution routes to correct internal tenant
      assert.strictEqual(await resolveClientByAccountingTenant(d1, 'xero', 'xero-tenant-alpha'), 1);
      assert.strictEqual(await resolveClientByAccountingTenant(d1, 'xero', 'xero-tenant-beta'), 2);
      assert.strictEqual(await resolveClientByAccountingTenant(d1, 'xero', 'xero-tenant-gamma'), null);
    });
  });

  // =========================================================================
  // Dimension 2: Duplicate Invoice Numbers Concurrency & High Volume Stress
  // =========================================================================
  describe('Dimension 2: Duplicate Invoice Numbers & Concurrency Stress', () => {
    test('10 different clients concurrently hold identical invoice number without collision', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 10);
      const d1 = db as unknown as D1Database;

      const identicalNumber = 'INV-100';

      // Concurrently insert identical invoice number for all 10 clients
      const insertPromises = [];
      for (let i = 1; i <= 10; i++) {
        insertPromises.push(
          upsertTenantInvoice(d1, i, {
            debtorName: `Debtor of Client ${i}`,
            debtorEmail: `debtor${i}@test.com`,
            invoiceNumber: identicalNumber,
            amountPence: i * 10000,
            dueDate: `2026-08-${String(i).padStart(2, '0')}`,
          })
        );
      }
      const results = await Promise.all(insertPromises);
      for (const res of results) {
        assert.strictEqual(res.action, 'inserted');
        assert.strictEqual(res.invoiceNumber, identicalNumber);
      }

      // Verify each client reads their own distinct invoice details
      for (let i = 1; i <= 10; i++) {
        const inv = await getTenantInvoiceByNumber(d1, i, identicalNumber);
        assert.ok(inv);
        assert.strictEqual(inv.clientId, i);
        assert.strictEqual(inv.debtorName, `Debtor of Client ${i}`);
        assert.strictEqual(inv.amountPence, i * 10000);
        assert.strictEqual(inv.dueDate, `2026-08-${String(i).padStart(2, '0')}`);
      }

      // Update Client 5 only
      await upsertTenantInvoice(d1, 5, {
        debtorName: 'Debtor of Client 5 UPDATED',
        invoiceNumber: identicalNumber,
        amountPence: 999999,
        dueDate: '2026-12-31',
      });

      // Verify Client 5 was updated
      const updated5 = await getTenantInvoiceByNumber(d1, 5, identicalNumber);
      assert.strictEqual(updated5?.debtorName, 'Debtor of Client 5 UPDATED');
      assert.strictEqual(updated5?.amountPence, 999999);

      // Verify Client 4 and Client 6 remain untouched
      const inv4 = await getTenantInvoiceByNumber(d1, 4, identicalNumber);
      assert.strictEqual(inv4?.debtorName, 'Debtor of Client 4');
      assert.strictEqual(inv4?.amountPence, 40000);

      const inv6 = await getTenantInvoiceByNumber(d1, 6, identicalNumber);
      assert.strictEqual(inv6?.debtorName, 'Debtor of Client 6');
      assert.strictEqual(inv6?.amountPence, 60000);
    });

    test('Stress Test: Rapid 50 successive upserts of same invoice guarantee single row idempotency', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 1);
      const d1 = db as unknown as D1Database;

      const invoiceNumber = 'INV-STRESS-RAPID';

      // 50 rapid sequential updates
      for (let step = 1; step <= 50; step++) {
        const res = await upsertTenantInvoice(d1, 1, {
          debtorName: `Debtor Revision ${step}`,
          invoiceNumber,
          amountPence: step * 500,
          dueDate: '2026-09-15',
        });
        if (step === 1) {
          assert.strictEqual(res.action, 'inserted');
        } else {
          assert.strictEqual(res.action, 'updated');
        }
      }

      // Verify exactly 1 invoice row exists
      const countRow = db.rawSqlite.prepare(
        'SELECT COUNT(*) AS total FROM invoices WHERE client_id = 1 AND invoice_number = ?'
      ).get(invoiceNumber) as any;
      assert.strictEqual(Number(countRow.total), 1);

      // Verify latest values are persisted
      const finalInvoice = await getTenantInvoiceByNumber(d1, 1, invoiceNumber);
      assert.ok(finalInvoice);
      assert.strictEqual(finalInvoice.debtorName, 'Debtor Revision 50');
      assert.strictEqual(finalInvoice.amountPence, 50 * 500);
    });
  });

  // =========================================================================
  // Dimension 3: Settled 'paid' Status Atomic Preservation Invariant
  // =========================================================================
  describe('Dimension 3: Atomic Paid Status Preservation', () => {
    test('upsertTenantInvoice preserves paid status against stale sync/import data', async () => {
      const db = createTestDb();
      seedMultipleClients(db, 1);
      const d1 = db as unknown as D1Database;

      // 1. Initial insert as overdue
      await upsertTenantInvoice(d1, 1, {
        debtorName: 'Alpha Corp',
        invoiceNumber: 'INV-PAY-PRESERVE',
        amountPence: 25000,
        dueDate: '2026-07-01',
        status: 'overdue',
      });

      // 2. Invoice is paid
      await upsertTenantInvoice(d1, 1, {
        debtorName: 'Alpha Corp',
        invoiceNumber: 'INV-PAY-PRESERVE',
        amountPence: 25000,
        dueDate: '2026-07-01',
        status: 'paid',
        paidDate: '2026-07-15',
      });

      let inv = await getTenantInvoiceByNumber(d1, 1, 'INV-PAY-PRESERVE');
      assert.strictEqual(inv?.status, 'paid');
      assert.strictEqual(inv?.paidDate, '2026-07-15');

      // 3. Stale sync arrives claiming invoice is 'overdue' with updated debtor details
      await upsertTenantInvoice(d1, 1, {
        debtorName: 'Alpha Corp Renamed',
        invoiceNumber: 'INV-PAY-PRESERVE',
        amountPence: 26000,
        dueDate: '2026-07-01',
        status: 'overdue', // STALE OVERDUE CLAIM
      });

      inv = await getTenantInvoiceByNumber(d1, 1, 'INV-PAY-PRESERVE');
      assert.ok(inv);
      // STRICT INVARIANT: Status MUST remain 'paid' and paidDate MUST NOT be wiped
      assert.strictEqual(inv.status, 'paid', 'Invariant violation: paid invoice was downgraded to overdue!');
      assert.strictEqual(inv.paidDate, '2026-07-15', 'Invariant violation: paidDate was wiped!');
      // Non-status fields can be legitimately updated
      assert.strictEqual(inv.debtorName, 'Alpha Corp Renamed');
      assert.strictEqual(inv.amountPence, 26000);
    });

    test('SyncService.reconcileInvoice preserves paid status against stale accounting data', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 1);
      const syncService = new SyncService(env.DB, env);

      // Insert invoice marked paid
      await upsertTenantInvoice(env.DB, 1, {
        debtorName: 'Settled Customer',
        invoiceNumber: 'INV-SETTLED-01',
        amountPence: 50000,
        dueDate: '2026-06-01',
        status: 'paid',
        paidDate: '2026-06-10',
      });

      // SyncService receives a stale raw invoice claiming unpaid (isPaid: false)
      const staleIncoming: NormalizedInvoice = {
        externalId: 'ext-settled-1',
        invoiceNumber: 'INV-SETTLED-01',
        debtorName: 'Settled Customer',
        debtorEmail: 'customer@test.com',
        amountPence: 50000,
        currency: 'GBP',
        dueDate: '2026-06-01',
        issuedDate: '2026-05-01',
        isPaid: false, // STALE UNPAID
        paidDate: null,
        isDisputedOrVoid: false,
      };

      const reconcileResult = await syncService.reconcileInvoice(1, staleIncoming);
      assert.strictEqual(reconcileResult, 'unchanged');

      const inv = await getTenantInvoiceByNumber(env.DB, 1, 'INV-SETTLED-01');
      assert.ok(inv);
      assert.strictEqual(inv.status, 'paid');
      assert.strictEqual(inv.paidDate, '2026-06-10');
    });

    test('Payment reconciliation automatically suppresses and skips active chase drafts', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 1);
      const syncService = new SyncService(env.DB, env);

      // Overdue invoice with a staged chase draft
      await upsertTenantInvoice(env.DB, 1, {
        debtorName: 'Debtor Under Chase',
        invoiceNumber: 'INV-CHASE-HALT',
        amountPence: 75000,
        dueDate: '2026-07-01',
        status: 'overdue',
      });
      const inv = (await getTenantInvoiceByNumber(env.DB, 1, 'INV-CHASE-HALT'))!;

      db.rawSqlite.exec(`
        INSERT INTO chase_log (invoice_id, step, channel, status, body, subject)
        VALUES (${inv.id}, 2, 'email', 'draft', 'Firm notice draft', 'Overdue notice');
      `);

      // Verify draft is pending
      const beforeDraft = db.rawSqlite.prepare('SELECT status FROM chase_log WHERE invoice_id = ?').get(inv.id) as any;
      assert.strictEqual(beforeDraft.status, 'draft');

      // Payment is reconciled via SyncService
      const paidIncoming: NormalizedInvoice = {
        externalId: 'ext-chase-1',
        invoiceNumber: 'INV-CHASE-HALT',
        debtorName: 'Debtor Under Chase',
        debtorEmail: 'debtor@test.com',
        amountPence: 75000,
        currency: 'GBP',
        dueDate: '2026-07-01',
        issuedDate: '2026-06-01',
        isPaid: true,
        paidDate: '2026-08-20',
        isDisputedOrVoid: false,
      };

      const result = await syncService.reconcileInvoice(1, paidIncoming);
      assert.strictEqual(result, 'marked_paid');

      // Verify invoice status updated
      const updatedInv = await getTenantInvoiceByNumber(env.DB, 1, 'INV-CHASE-HALT');
      assert.strictEqual(updatedInv?.status, 'paid');

      // STRICT INVARIANT: Staged draft MUST be skipped so debtor is not harassed
      const afterDraft = db.rawSqlite.prepare('SELECT status, reviewed_at FROM chase_log WHERE invoice_id = ?').get(inv.id) as any;
      assert.strictEqual(afterDraft.status, 'skipped');
      assert.ok(afterDraft.reviewed_at);
    });
  });

  // =========================================================================
  // Dimension 4: Webhook Deduplication & Signature Tampering
  // =========================================================================
  describe('Dimension 4: Webhooks & Signature Security', () => {
    test('High volume duplicate webhook events are idempotently deduplicated', async () => {
      const db = createTestDb();
      const d1 = db as unknown as D1Database;

      const eventId = 'evt_rapid_replay_999';

      // 30 rapid duplicate webhook submissions
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          recordAccountingWebhook(d1, eventId, 'xero', { resourceId: 'inv-replay-1' })
        )
      );

      // Exactly ONE returns true (new), 29 return false (duplicate)
      const trueCount = results.filter(r => r === true).length;
      const falseCount = results.filter(r => r === false).length;

      assert.strictEqual(trueCount, 1, 'Expected exactly 1 webhook event to be accepted');
      assert.strictEqual(falseCount, 29, 'Expected 29 duplicate webhook events to be rejected');

      // Database has exactly 1 row
      const count = db.rawSqlite.prepare(
        'SELECT COUNT(*) as total FROM accounting_webhook_events WHERE id = ?'
      ).get(eventId) as any;
      assert.strictEqual(Number(count.total), 1);
    });

    test('Xero webhook strictly rejects tampered HMAC signature with HTTP 401', async () => {
      const { env } = createTestEnv({
        XERO_WEBHOOK_KEY: 'test-xero-signing-key-12345!',
      } as any);

      const payload = JSON.stringify({
        events: [{ eventCategory: 'INVOICE', eventType: 'UPDATE', resourceId: 'inv-123' }],
      });

      // Valid signature
      const validSig = await signHmacSha256(payload, 'test-xero-signing-key-12345!');

      // Valid request passes signature verification
      const validReq = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': validSig,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      const validRes = await worker.fetch(validReq, env);
      assert.strictEqual(validRes.status, 200);

      // Tampered signature is rejected with 401
      const tamperedReq = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: {
          'x-xero-signature': 'tampered_signature_invalid',
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      const tamperedRes = await worker.fetch(tamperedReq, env);
      assert.strictEqual(tamperedRes.status, 401);

      // Missing signature is rejected with 401
      const missingReq = new Request('http://localhost/api/webhooks/xero', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      const missingRes = await worker.fetch(missingReq, env);
      assert.strictEqual(missingRes.status, 401);
    });
  });

  // =========================================================================
  // Dimension 5: API Endpoint Boundaries & Cross-Tenant Snooping
  // =========================================================================
  describe('Dimension 5: API Endpoint Boundaries & Cross-Tenant Snooping', () => {
    test('Portal Dashboard strictly isolates Client A data from Client B', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 2);

      // Client 1 Invoices
      await upsertTenantInvoice(env.DB, 1, {
        debtorName: 'Client 1 Unique Debtor',
        invoiceNumber: 'INV-CL1-ONLY',
        amountPence: 123456,
        dueDate: '2026-08-01',
      });

      // Client 2 Invoices
      await upsertTenantInvoice(env.DB, 2, {
        debtorName: 'Client 2 Highly Confidential Debtor',
        invoiceNumber: 'INV-CL2-SECRET',
        amountPence: 9999999,
        dueDate: '2026-08-01',
      });

      // Authenticate as Client 1
      const cookie1 = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request('http://localhost/portal/dashboard', {
        headers: { Cookie: cookie1 },
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);
      const html = await res.text();

      // Client 1's data is present
      assert.ok(html.includes('Company 1'));
      assert.ok(html.includes('INV-CL1-ONLY'));

      // Client 2's data MUST NOT LEAK
      assert.ok(!html.includes('INV-CL2-SECRET'), 'Leak: Client 2 invoice number leaked to Client 1!');
      assert.ok(!html.includes('Client 2 Highly Confidential Debtor'), 'Leak: Client 2 debtor leaked to Client 1!');
      assert.ok(!html.includes('Company 2'), 'Leak: Client 2 company name leaked to Client 1!');
    });

    test('OAuth Connect binds state to authenticated session even if client_id query param attempts spoofing', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 2);

      // Client 1 is logged in via cookie, but passes ?client_id=2 in URL attempting to initiate OAuth for Client 2
      const cookie1 = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request('http://localhost/api/oauth/xero/connect?client_id=2', {
        headers: { Cookie: cookie1 },
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 302);
      const location = res.headers.get('Location') ?? '';

      const stateParam = new URL(location).searchParams.get('state') ?? '';
      const verifiedState = await verifyOAuthState(stateParam, env.PORTAL_SESSION_SECRET, 'xero');

      // STRICT CHECK: State MUST be bound to authenticated Client 1, NOT spoofed Client 2!
      assert.ok(verifiedState);
      assert.strictEqual(verifiedState.cid, 1, 'Vulnerability: OAuth state bound to unauthenticated spoofed client_id parameter!');
    });

    test('OAuth Status returns authenticated client status even if client_id query param attempts spoofing', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 2);

      // Client 1 is connected to Xero
      await upsertAccountingConnection(env.DB, 1, {
        provider: 'xero',
        tenantId: 'xero-tenant-cl1',
        accessTokenEncrypted: 'enc_1',
        refreshTokenEncrypted: 'enc_ref_1',
        expiresAt: '2026-10-01T00:00:00Z',
        status: 'active',
      });

      // Client 2 is NOT connected
      const cookie1 = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);

      // Client 1 asks for status with ?client_id=2
      const req = new Request('http://localhost/api/oauth/xero/status?client_id=2', {
        headers: { Cookie: cookie1 },
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as any;

      // Authenticated Client 1's status (connected: true) is returned, NOT client 2's (which would be false)
      assert.strictEqual(json.connected, true);
      assert.strictEqual(json.tenant_id, 'xero-tenant-cl1');
    });

    test('Empirical Boundary Analysis: Unauthenticated disconnect and status endpoints behavior', async () => {
      const { env, db } = createTestEnv();
      seedMultipleClients(db, 2);

      // Client 2 has active connection
      await upsertAccountingConnection(env.DB, 2, {
        provider: 'xero',
        tenantId: 'xero-tenant-cl2',
        accessTokenEncrypted: 'enc_2',
        refreshTokenEncrypted: 'enc_ref_2',
        expiresAt: '2026-10-01T00:00:00Z',
        status: 'active',
      });

      // 1. Unauthenticated disconnect attempt with { client_id: 2 } must be strictly rejected with HTTP 401
      const unauthReq = new Request('http://localhost/api/oauth/xero/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 2 }),
      });

      const res = await worker.fetch(unauthReq, env);
      assert.strictEqual(res.status, 401, 'Unauthenticated caller must be rejected with 401 Unauthorized');
      const unauthJson = (await res.json()) as any;
      assert.strictEqual(unauthJson.error, 'Unauthorized');

      // Verify connection was NOT deleted
      const postConn = await getAccountingConnection(env.DB, 2, 'xero');
      assert.ok(postConn, 'Connection must remain intact and must not be deleted');
      assert.strictEqual(postConn.status, 'active', 'Connection must remain active');

      // 2. Unauthenticated status request with ?client_id=2 must be rejected with HTTP 401
      const unauthStatusReq = new Request('http://localhost/api/oauth/xero/status?client_id=2');
      const statusRes = await worker.fetch(unauthStatusReq, env);
      assert.strictEqual(statusRes.status, 401, 'Unauthenticated status query must be rejected with 401');

      // 3. Unauthenticated refresh request with { client_id: 2 } must be rejected with HTTP 401
      const unauthRefreshReq = new Request('http://localhost/api/oauth/xero/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 2 }),
      });
      const refreshRes = await worker.fetch(unauthRefreshReq, env);
      assert.strictEqual(refreshRes.status, 401, 'Unauthenticated refresh query must be rejected with 401');
    });
  });
});
