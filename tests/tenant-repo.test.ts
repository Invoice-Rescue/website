import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './e2e/harness';
import {
  getTenantInvoices,
  getTenantInvoiceByNumber,
  getTenantInvoiceById,
  upsertTenantInvoice,
  recordAccountingWebhook,
  getAccountingConnection,
  upsertAccountingConnection,
  resolveClientByAccountingTenant,
  getTenantDrafts,
  approveTenantDraft,
  skipTenantDraft,
  TenantRepository,
  InvalidTenantError,
  InvalidInvoiceDataError,
  InvalidWebhookEventError,
} from '../backend/src/lib/tenant-repo';

describe('Tenant Repository & Multi-Tenant Data Isolation', () => {
  function seedClients(db: any) {
    db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, plan, status)
      VALUES (1, 'Alpha Corp', 'alpha@corp.test', 'engine', 'active'),
             (2, 'Beta Ltd', 'beta@ltd.test', 'foundation', 'active');
    `);
  }

  test('validateClientId rejects invalid client IDs', () => {
    const db = createTestDb() as unknown as D1Database;
    assert.rejects(async () => getTenantInvoices(db, 0), InvalidTenantError);
    assert.rejects(async () => getTenantInvoices(db, -1), InvalidTenantError);
    assert.rejects(async () => getTenantInvoices(db, 1.5 as any), InvalidTenantError);
    assert.rejects(async () => getTenantInvoices(db, '1' as any), InvalidTenantError);
    assert.rejects(async () => getTenantInvoices(db, null as any), InvalidTenantError);
  });

  test('validateInvoiceInput validates required fields and format', async () => {
    const db = createTestDb() as unknown as D1Database;
    // Missing invoiceNumber
    await assert.rejects(
      async () => upsertTenantInvoice(db, 1, { debtorName: 'Acme', invoiceNumber: '', amountPence: 1000, dueDate: '2026-09-01' }),
      InvalidInvoiceDataError
    );
    // Invalid amountPence
    await assert.rejects(
      async () => upsertTenantInvoice(db, 1, { debtorName: 'Acme', invoiceNumber: 'INV-1', amountPence: -500, dueDate: '2026-09-01' }),
      InvalidInvoiceDataError
    );
    // Invalid dueDate
    await assert.rejects(
      async () => upsertTenantInvoice(db, 1, { debtorName: 'Acme', invoiceNumber: 'INV-1', amountPence: 1000, dueDate: '01/09/2026' }),
      InvalidInvoiceDataError
    );
  });

  test('cross-tenant read isolation: Client A only sees Client A invoices', async () => {
    const db = createTestDb();
    seedClients(db);

    await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Debtor Alpha',
      debtorEmail: 'alpha-debtor@test.com',
      invoiceNumber: 'INV-A1',
      amountPence: 50000,
      dueDate: '2026-08-01',
    });

    await upsertTenantInvoice(db as unknown as D1Database, 2, {
      debtorName: 'Debtor Beta',
      debtorEmail: 'beta-debtor@test.com',
      invoiceNumber: 'INV-B1',
      amountPence: 75000,
      dueDate: '2026-08-15',
    });

    const client1Invoices = await getTenantInvoices(db as unknown as D1Database, 1);
    assert.strictEqual(client1Invoices.length, 1);
    assert.strictEqual(client1Invoices[0].invoiceNumber, 'INV-A1');
    assert.strictEqual(client1Invoices[0].debtorName, 'Debtor Alpha');

    const client2Invoices = await getTenantInvoices(db as unknown as D1Database, 2);
    assert.strictEqual(client2Invoices.length, 1);
    assert.strictEqual(client2Invoices[0].invoiceNumber, 'INV-B1');
    assert.strictEqual(client2Invoices[0].debtorName, 'Debtor Beta');
  });

  test('identical invoice numbers across different clients do not collide', async () => {
    const db = createTestDb();
    seedClients(db);

    // Both clients have invoice INV-999
    const res1 = await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Client 1 Debtor',
      invoiceNumber: 'INV-999',
      amountPence: 12000,
      dueDate: '2026-08-01',
    });
    assert.strictEqual(res1.action, 'inserted');

    const res2 = await upsertTenantInvoice(db as unknown as D1Database, 2, {
      debtorName: 'Client 2 Debtor',
      invoiceNumber: 'INV-999',
      amountPence: 99000,
      dueDate: '2026-08-02',
    });
    assert.strictEqual(res2.action, 'inserted');

    const inv1 = await getTenantInvoiceByNumber(db as unknown as D1Database, 1, 'INV-999');
    assert.ok(inv1);
    assert.strictEqual(inv1.amountPence, 12000);

    const inv2 = await getTenantInvoiceByNumber(db as unknown as D1Database, 2, 'INV-999');
    assert.ok(inv2);
    assert.strictEqual(inv2.amountPence, 99000);

    // Querying client 1 with client 2's specific details doesn't leak
    assert.strictEqual(inv1.debtorName, 'Client 1 Debtor');
    assert.strictEqual(inv2.debtorName, 'Client 2 Debtor');
  });

  test('atomic upsert updates invoice without duplicate crash and respects paid status', async () => {
    const db = createTestDb();
    seedClients(db);

    // Insert initially
    await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Initial Debtor',
      invoiceNumber: 'INV-REIMPORT',
      amountPence: 30000,
      dueDate: '2026-08-01',
      status: 'overdue',
    });

    // Re-import with updated amount
    const updateRes = await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Updated Debtor Name',
      invoiceNumber: 'INV-REIMPORT',
      amountPence: 35000,
      dueDate: '2026-08-05',
      status: 'overdue',
    });
    assert.strictEqual(updateRes.action, 'updated');

    let invoice = await getTenantInvoiceByNumber(db as unknown as D1Database, 1, 'INV-REIMPORT');
    assert.ok(invoice);
    assert.strictEqual(invoice.amountPence, 35000);
    assert.strictEqual(invoice.debtorName, 'Updated Debtor Name');

    // Mark as paid
    await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Updated Debtor Name',
      invoiceNumber: 'INV-REIMPORT',
      amountPence: 35000,
      dueDate: '2026-08-05',
      status: 'paid',
    });
    invoice = await getTenantInvoiceByNumber(db as unknown as D1Database, 1, 'INV-REIMPORT');
    assert.ok(invoice);
    assert.strictEqual(invoice.status, 'paid');
    assert.ok(invoice.paidDate);

    // Re-importing as overdue must NEVER un-pay a settled invoice!
    await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Updated Debtor Name',
      invoiceNumber: 'INV-REIMPORT',
      amountPence: 35000,
      dueDate: '2026-08-05',
      status: 'overdue',
    });
    invoice = await getTenantInvoiceByNumber(db as unknown as D1Database, 1, 'INV-REIMPORT');
    assert.ok(invoice);
    assert.strictEqual(invoice.status, 'paid');
  });

  test('getTenantInvoiceById strictly checks client ownership', async () => {
    const db = createTestDb();
    seedClients(db);

    await upsertTenantInvoice(db as unknown as D1Database, 1, {
      debtorName: 'Client 1 Debtor',
      invoiceNumber: 'INV-SECRET-1',
      amountPence: 10000,
      dueDate: '2026-08-01',
    });

    const inv = await getTenantInvoiceByNumber(db as unknown as D1Database, 1, 'INV-SECRET-1');
    assert.ok(inv);

    // Client 1 can access
    const fetchedByOwner = await getTenantInvoiceById(db as unknown as D1Database, 1, inv.id);
    assert.ok(fetchedByOwner);
    assert.strictEqual(fetchedByOwner.invoiceNumber, 'INV-SECRET-1');

    // Client 2 cannot access Client 1's invoice ID
    const fetchedByOther = await getTenantInvoiceById(db as unknown as D1Database, 2, inv.id);
    assert.strictEqual(fetchedByOther, null);
  });

  test('recordAccountingWebhook enforces idempotency and rejects duplicates', async () => {
    const db = createTestDb();

    // First time returns true (new event)
    const first = await recordAccountingWebhook(
      db as unknown as D1Database,
      'evt_unique_123',
      'xero',
      { resourceId: 'inv-123' }
    );
    assert.strictEqual(first, true);

    // Second time returns false (duplicate event)
    const second = await recordAccountingWebhook(
      db as unknown as D1Database,
      'evt_unique_123',
      'xero',
      { resourceId: 'inv-123' }
    );
    assert.strictEqual(second, false);

    // Invalid parameters throw error
    await assert.rejects(
      async () => recordAccountingWebhook(db as unknown as D1Database, '', 'xero', {}),
      InvalidWebhookEventError
    );
    await assert.rejects(
      async () => recordAccountingWebhook(db as unknown as D1Database, 'evt_1', 'stripe' as any, {}),
      InvalidWebhookEventError
    );
  });

  test('accounting connection lifecycle and tenant resolution', async () => {
    const db = createTestDb();
    seedClients(db);

    await upsertAccountingConnection(db as unknown as D1Database, 1, {
      provider: 'xero',
      tenantId: 'xero-tenant-uuid-abc',
      accessTokenEncrypted: 'enc_access_token',
      refreshTokenEncrypted: 'enc_refresh_token',
      expiresAt: '2026-09-16T12:00:00Z',
      status: 'active',
    });

    // Resolve tenant ID to client ID
    const resolvedClientId = await resolveClientByAccountingTenant(
      db as unknown as D1Database,
      'xero',
      'xero-tenant-uuid-abc'
    );
    assert.strictEqual(resolvedClientId, 1);

    // Non-existent tenant ID returns null
    const nonExistent = await resolveClientByAccountingTenant(
      db as unknown as D1Database,
      'xero',
      'unknown-tenant'
    );
    assert.strictEqual(nonExistent, null);

    // Fetch connection scoped to tenant
    const conn = await getAccountingConnection(db as unknown as D1Database, 1, 'xero');
    assert.ok(conn);
    assert.strictEqual(conn.tenantId, 'xero-tenant-uuid-abc');
    assert.strictEqual(conn.provider, 'xero');

    // Client 2 has no Xero connection
    const conn2 = await getAccountingConnection(db as unknown as D1Database, 2, 'xero');
    assert.strictEqual(conn2, null);
  });

  test('TenantRepository class binds clientId permanently and prevents cross-tenant leakage', async () => {
    const db = createTestDb();
    seedClients(db);

    const repo1 = new TenantRepository(db as unknown as D1Database, 1);
    const repo2 = new TenantRepository(db as unknown as D1Database, 2);

    await repo1.upsertInvoice({
      debtorName: 'Repo 1 Debtor',
      invoiceNumber: 'INV-REPO-1',
      amountPence: 25000,
      dueDate: '2026-08-10',
    });

    const client1Invoices = await repo1.getInvoices();
    assert.strictEqual(client1Invoices.length, 1);

    const client2Invoices = await repo2.getInvoices();
    assert.strictEqual(client2Invoices.length, 0);

    // Check drafts
    db.rawSqlite.exec(`
      INSERT INTO chase_log (invoice_id, step, channel, status, body)
      VALUES (${client1Invoices[0].id}, 1, 'email', 'draft', 'Draft for Client 1');
    `);

    const drafts1 = await repo1.getDrafts();
    assert.strictEqual(drafts1.length, 1);

    const drafts2 = await repo2.getDrafts();
    assert.strictEqual(drafts2.length, 0);

    // Client 2 cannot approve Client 1's draft
    const approvedByOther = await repo2.approveDraft(drafts1[0].id, 'Hacked Body', 'Hacker');
    assert.strictEqual(approvedByOther, false);

    // Client 1 can approve
    const approvedByOwner = await repo1.approveDraft(drafts1[0].id, 'Approved Body', 'Tibor Rames');
    assert.strictEqual(approvedByOwner, true);
  });
});
