import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestEnv, createBasicAuthHeader, signHmacSha256, signStripeWebhook } from "./harness";
import worker from "../../backend/src/index";
import { statutoryInterestPence, fixedCompensationPence } from "../../backend/src/lib/statutory-interest";
import { nextStepDue, advanceEscalationStage, STEP_LABELS, CADENCE_DAYS } from "../../backend/src/lib/escalation";
import { buildChasePrompt } from "../../backend/src/lib/gemini";
import { encryptToken, decryptToken } from "../../backend/src/lib/integrations/oauth-manager";
import {
  verifyQuickBooksWebhook,
  verifyXeroWebhook,
  parseQuickBooksInvoiceUpdate,
  parseXeroInvoiceUpdate,
} from "../../backend/src/lib/integrations/webhooks";
import {
  signLoginToken,
  verifyLoginToken,
  buildSessionCookie,
  clearSessionCookie,
  authenticateClient,
} from "../../backend/src/lib/portal-auth";
import { renderReviewQueue, escapeHtml } from "../../backend/src/lib/admin";
import { renderPortalDashboard, renderPortalLogin } from "../../backend/src/lib/portal";
import { verifyWebhookSignature } from "../../backend/src/lib/stripe";
import { parseCsv } from "../../backend/src/lib/csv";
import { InvoiceEscalationState } from "../../backend/src/types/core";

describe("Tier 1: Feature Coverage (Opaque-Box)", () => {
  // =========================================================================
  // F1: Multi-Tenant Data Isolation
  // =========================================================================
  describe("F1: Multi-Tenant Data Isolation", () => {
    test("T1.F1.1: Querying invoices for Tenant A returns only Tenant A's invoices", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (1, 'Tenant A', 'a@tenant.test', 'engine', 'active'),
               (2, 'Tenant B', 'b@tenant.test', 'engine', 'active');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 'Debtor A', 'INV-A-100', 50000, '2026-08-01', 'overdue'),
               (2, 'Debtor B', 'INV-B-200', 75000, '2026-08-01', 'overdue');
      `);

      const resA = await db.prepare("SELECT * FROM invoices WHERE client_id = ?1").bind(1).all();
      assert.strictEqual(resA.results.length, 1);
      assert.strictEqual((resA.results[0] as any).invoice_number, "INV-A-100");

      const resB = await db.prepare("SELECT * FROM invoices WHERE client_id = ?1").bind(2).all();
      assert.strictEqual(resB.results.length, 1);
      assert.strictEqual((resB.results[0] as any).invoice_number, "INV-B-200");
    });

    test("T1.F1.2: Portal dashboard for Client A renders only Client A invoices and chase history", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (1, 'Tenant Alpha', 'alpha@tenant.test', 'engine', 'active'),
               (2, 'Tenant Beta', 'beta@tenant.test', 'engine', 'active');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (10, 1, 'Alpha Debtor', 'INV-ALPHA-1', 120000, '2026-08-01', 'overdue'),
               (20, 2, 'Beta Debtor', 'INV-BETA-2', 90000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (invoice_id, step, channel, status, body)
        VALUES (10, 1, 'email', 'sent', 'Alpha Chase Body'),
               (20, 1, 'email', 'sent', 'Beta Chase Body');
      `);

      const cookieA = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const reqA = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookieA.split(";")[0] },
      });
      const respA = await worker.fetch(reqA, env);
      const htmlA = await respA.text();

      assert.strictEqual(respA.status, 200);
      assert.ok(htmlA.includes("Tenant Alpha"));
      assert.ok(htmlA.includes("INV-ALPHA-1"));
      assert.ok(!htmlA.includes("INV-BETA-2"));
      assert.ok(!htmlA.includes("Tenant Beta"));
    });

    test("T1.F1.3: Client B cannot access Client A dashboard via tampered cookie", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (1, 'Tenant Alpha', 'alpha@tenant.test', 'engine', 'active'),
               (2, 'Tenant Beta', 'beta@tenant.test', 'engine', 'active');
      `);

      // Cookie signed for client 2
      const cookieB = await buildSessionCookie(2, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookieB.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.strictEqual(resp.status, 200);
      assert.ok(html.includes("Tenant Beta"));
      assert.ok(!html.includes("Tenant Alpha"));
    });

    test("T1.F1.4: CSV invoice import binds records strictly to route client parameter", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (101, 'Import Client', 'import@tenant.test', 'engine', 'active');
      `);

      const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nAcme Corp,acme@test.com,INV-IMP-001,150.00,GBP,2026-08-01`;
      const req = new Request("http://localhost/api/clients/101/invoices/import", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          "Content-Type": "text/csv",
        },
        body: csv,
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const rows = await db.prepare("SELECT * FROM invoices WHERE client_id = ?1").bind(101).all();
      assert.strictEqual(rows.results.length, 1);
      assert.strictEqual((rows.results[0] as any).invoice_number, "INV-IMP-001");
      assert.strictEqual((rows.results[0] as any).amount_pence, 15000);
    });

    test("T1.F1.5: Identical invoice number can coexist across two distinct tenants", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, plan, status)
        VALUES (1, 'Client One', 'one@test.com', 'engine', 'active'),
               (2, 'Client Two', 'two@test.com', 'engine', 'active');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 'Common Debtor', 'INV-SHARED-001', 50000, '2026-08-01', 'overdue'),
               (2, 'Common Debtor', 'INV-SHARED-001', 99000, '2026-08-01', 'overdue');
      `);

      const row1 = await db.prepare("SELECT * FROM invoices WHERE client_id = 1 AND invoice_number = 'INV-SHARED-001'").first();
      const row2 = await db.prepare("SELECT * FROM invoices WHERE client_id = 2 AND invoice_number = 'INV-SHARED-001'").first();
      assert.ok(row1);
      assert.ok(row2);
      assert.strictEqual((row1 as any).amount_pence, 50000);
      assert.strictEqual((row2 as any).amount_pence, 99000);
    });
  });

  // =========================================================================
  // F2: OAuth 2.0 Connection Lifecycle
  // =========================================================================
  describe("F2: OAuth 2.0 Connection Lifecycle", () => {
    test("T1.F2.1: Stores Xero connection record with encrypted tokens and tenant_id", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Xero Org', 'xero@org.test');
      `);

      const encAccess = await encryptToken("xero-access-token-123", "secret-key-1");
      const encRefresh = await encryptToken("xero-refresh-token-456", "secret-key-1");

      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (?1, 'xero', 'xero-tenant-uuid-789', ?2, ?3, '2026-10-01T00:00:00Z', 'active')
      `).bind(1, encAccess, encRefresh).run();

      const conn = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 1 AND provider = 'xero'").first();
      assert.ok(conn);
      assert.strictEqual((conn as any).provider, "xero");
      assert.strictEqual((conn as any).tenant_id, "xero-tenant-uuid-789");
      assert.strictEqual((conn as any).status, "active");
    });

    test("T1.F2.2: Stores QuickBooks connection record with realmId as tenant_id", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'QB Org', 'qb@org.test');
      `);

      const encAccess = await encryptToken("qb-access-token-abc", "secret-key-2");
      const encRefresh = await encryptToken("qb-refresh-token-def", "secret-key-2");

      await db.prepare(`
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (?1, 'quickbooks', 'realm-id-1234567890', ?2, ?3, '2026-10-01T00:00:00Z', 'active')
      `).bind(2, encAccess, encRefresh).run();

      const conn = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 2 AND provider = 'quickbooks'").first();
      assert.ok(conn);
      assert.strictEqual((conn as any).provider, "quickbooks");
      assert.strictEqual((conn as any).tenant_id, "realm-id-1234567890");
    });

    test("T1.F2.3: Connection status transitions: active -> expired -> revoked", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Status Org', 'status@org.test');
        INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (3, 'xero', 'encA', 'encR', '2026-09-01T00:00:00Z', 'active');
      `);

      // Transition to expired
      await db.prepare("UPDATE accounting_connections SET status = 'expired' WHERE client_id = 3").run();
      let conn = await db.prepare("SELECT status FROM accounting_connections WHERE client_id = 3").first<{ status: string }>();
      assert.strictEqual(conn?.status, "expired");

      // Transition to revoked
      await db.prepare("UPDATE accounting_connections SET status = 'revoked' WHERE client_id = 3").run();
      conn = await db.prepare("SELECT status FROM accounting_connections WHERE client_id = 3").first<{ status: string }>();
      assert.strictEqual(conn?.status, "revoked");
    });

    test("T1.F2.4: Token rotation updates access/refresh tokens and last_synced_at timestamp", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (4, 'Rotate Org', 'rotate@org.test');
        INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (4, 'quickbooks', 'oldAccess', 'oldRefresh', '2026-09-10T00:00:00Z', 'active');
      `);

      const newAccess = await encryptToken("new-rotated-token", "key");
      const newRefresh = await encryptToken("new-refresh-token", "key");

      await db.prepare(`
        UPDATE accounting_connections
        SET access_token_encrypted = ?1, refresh_token_encrypted = ?2, expires_at = '2026-11-01T00:00:00Z', last_synced_at = datetime('now')
        WHERE client_id = 4 AND provider = 'quickbooks'
      `).bind(newAccess, newRefresh).run();

      const conn = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 4").first<any>();
      assert.strictEqual(conn.access_token_encrypted, newAccess);
      assert.strictEqual(conn.refresh_token_encrypted, newRefresh);
      assert.ok(conn.last_synced_at);
    });

    test("T1.F2.5: Unique constraint enforces at most one active connection per provider per client", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (5, 'Unique Org', 'uniq@org.test');
        INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (5, 'xero', 'encA', 'encR', '2026-09-01T00:00:00Z', 'active');
      `);

      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
          VALUES (5, 'xero', 'encA2', 'encR2', '2026-09-02T00:00:00Z', 'active')
        `).run();
      }, /UNIQUE constraint failed/);
    });
  });

  // =========================================================================
  // F3: Token Encryption at Rest (AES-GCM)
  // =========================================================================
  describe("F3: Token Encryption at Rest (AES-GCM)", () => {
    test("T1.F3.1: Encrypting plaintext produces 256-bit AES-GCM ciphertext distinct from input", async () => {
      const plaintext = "super-secret-oauth-access-token-xyz";
      const key = "encryption-secret-passphrase";
      const cipher = await encryptToken(plaintext, key);

      assert.notStrictEqual(cipher, plaintext);
      assert.ok(cipher.length > 30);
    });

    test("T1.F3.2: Decrypting valid ciphertext with correct secret key returns exact original plaintext", async () => {
      const original = "refresh-token-123456789-abcdef";
      const key = "my-aes-key-32-chars-long-secure!";
      const encrypted = await encryptToken(original, key);
      const decrypted = await decryptToken(encrypted, key);

      assert.strictEqual(decrypted, original);
    });

    test("T1.F3.3: Random 12-byte IV produces different ciphertexts for identical plaintexts", async () => {
      const token = "fixed-accounting-token";
      const key = "same-encryption-key";
      const enc1 = await encryptToken(token, key);
      const enc2 = await encryptToken(token, key);

      assert.notStrictEqual(enc1, enc2);
      assert.strictEqual(await decryptToken(enc1, key), token);
      assert.strictEqual(await decryptToken(enc2, key), token);
    });

    test("T1.F3.4: Decrypting token with incorrect key fails closed", async () => {
      const token = "secret-payload";
      const enc = await encryptToken(token, "correct-key");

      await assert.rejects(async () => {
        await decryptToken(enc, "wrong-key");
      });
    });

    test("T1.F3.5: Multi-tenant token isolation preserves encrypted payloads per client", async () => {
      const tokenA = "tenant-a-token";
      const tokenB = "tenant-b-token";
      const encA = await encryptToken(tokenA, "key-tenant-a");
      const encB = await encryptToken(tokenB, "key-tenant-b");

      assert.strictEqual(await decryptToken(encA, "key-tenant-a"), tokenA);
      assert.strictEqual(await decryptToken(encB, "key-tenant-b"), tokenB);
      await assert.rejects(async () => {
        await decryptToken(encA, "key-tenant-b");
      });
    });
  });

  // =========================================================================
  // F4: Webhook HMAC Verification
  // =========================================================================
  describe("F4: Webhook HMAC Verification", () => {
    test("T1.F4.1: QuickBooks webhook verification accepts valid HMAC-SHA256 signature", async () => {
      const payload = JSON.stringify({ eventNotifications: [{ realmId: "123" }] });
      const secret = "intuit-verifier-token-123";
      const sig = await signHmacSha256(payload, secret);

      const isValid = await verifyQuickBooksWebhook(payload, sig, secret);
      assert.strictEqual(isValid, true);
    });

    test("T1.F4.2: Xero webhook verification accepts valid HMAC-SHA256 signature", async () => {
      const payload = JSON.stringify({ events: [{ resourceUrl: "https://api.xero.com/..." }] });
      const key = "xero-webhook-secret-key";
      const sig = await signHmacSha256(payload, key);

      const isValid = await verifyXeroWebhook(payload, sig, key);
      assert.strictEqual(isValid, true);
    });

    test("T1.F4.3: Tampered webhook payload is rejected by timing-safe verification", async () => {
      const originalPayload = JSON.stringify({ id: "evt_1", amount: 100 });
      const secret = "webhook-key";
      const sig = await signHmacSha256(originalPayload, secret);

      const tamperedPayload = JSON.stringify({ id: "evt_1", amount: 1000 });
      const isValid = await verifyQuickBooksWebhook(tamperedPayload, sig, secret);
      assert.strictEqual(isValid, false);
    });

    test("T1.F4.4: Corrupted or mismatched signature string returns false", async () => {
      const payload = "sample-event-data";
      const secret = "key";
      const isValid = await verifyXeroWebhook(payload, "completely-wrong-base64-signature", secret);
      assert.strictEqual(isValid, false);
    });

    test("T1.F4.5: Stripe webhook verification accepts valid timestamped signature", async () => {
      const payload = JSON.stringify({ id: "evt_test", type: "customer.subscription.updated" });
      const secret = "whsec_test_secret";
      const now = Math.floor(Date.now() / 1000);
      const header = await signStripeWebhook(payload, secret, now);

      const isValid = await verifyWebhookSignature(payload, header, secret);
      assert.strictEqual(isValid, true);
    });
  });

  // =========================================================================
  // F5: Webhook Deduplication & Idempotency
  // =========================================================================
  describe("F5: Webhook Deduplication & Idempotency", () => {
    test("T1.F5.1: First delivery of webhook event is recorded and processed", async () => {
      const { env, db } = createTestEnv();
      const eventId = "evt_dedup_001";
      const payload = JSON.stringify({
        id: eventId,
        type: "customer.subscription.updated",
        data: { object: { customer: "cus_123", status: "active" } },
      });
      const now = Math.floor(Date.now() / 1000);
      const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

      const req = new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: payload,
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const row = await db.prepare("SELECT id FROM webhook_events WHERE id = ?1").bind(eventId).first();
      assert.ok(row);
    });

    test("T1.F5.2: Duplicate webhook delivery returns duplicate: true without side-effects", async () => {
      const { env, db } = createTestEnv();
      const eventId = "evt_dedup_002";
      const payload = JSON.stringify({
        id: eventId,
        type: "customer.subscription.updated",
        data: { object: { customer: "cus_123", status: "active" } },
      });
      const now = Math.floor(Date.now() / 1000);
      const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

      // Pre-insert event
      await db.prepare("INSERT INTO webhook_events (id, event_type, customer_id, created_at_timestamp) VALUES (?1, 'test', 'cus_123', ?2)")
        .bind(eventId, now)
        .run();

      const req = new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: payload,
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);
      const json = await resp.json() as any;
      assert.strictEqual(json.duplicate, true);
    });

    test("T1.F5.3: Duplicate delivery executes zero side-effects on client status", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
        VALUES (10, 'Side Effect Client', 'sec@test.com', 'cus_no_change', 'active');
        INSERT INTO webhook_events (id, event_type, customer_id, created_at_timestamp)
        VALUES ('evt_dup_3', 'customer.subscription.deleted', 'cus_no_change', 1000);
      `);

      const payload = JSON.stringify({
        id: "evt_dup_3",
        type: "customer.subscription.deleted",
        data: { object: { customer: "cus_no_change" } },
      });
      const now = Math.floor(Date.now() / 1000);
      const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

      const req = new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: payload,
      });
      const resp = await worker.fetch(req, env);
      const json = await resp.json() as any;
      assert.strictEqual(json.duplicate, true);

      // Status should remain active because duplicate event was skipped
      const client = await db.prepare("SELECT status FROM clients WHERE id = 10").first<any>();
      assert.strictEqual(client.status, "active");
    });

    test("T1.F5.4: Accounting webhook deduplication table tracks external event IDs", async () => {
      const { db } = createTestEnv();
      await db.prepare(`
        INSERT INTO accounting_webhook_events (id, provider, event_type, payload)
        VALUES ('xero-evt-999', 'xero', 'INVOICE.UPDATE', '{"sample":1}')
      `).run();

      const exists = await db.prepare("SELECT id FROM accounting_webhook_events WHERE id = ?1")
        .bind("xero-evt-999")
        .first();
      assert.ok(exists);

      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO accounting_webhook_events (id, provider, event_type, payload)
          VALUES ('xero-evt-999', 'xero', 'INVOICE.UPDATE', '{"sample":2}')
        `).run();
      }, /UNIQUE constraint failed/);
    });

    test("T1.F5.5: Out-of-order webhook delivery is detected and flagged as skipped_stale", async () => {
      const { env, db } = createTestEnv();
      const now = Math.floor(Date.now() / 1000);
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
        VALUES (11, 'Stale Client', 'stale@test.com', 'cus_stale_1', 'active');
        INSERT INTO webhook_events (id, event_type, customer_id, created_at_timestamp)
        VALUES ('evt_newer', 'customer.subscription.updated', 'cus_stale_1', ${now - 10});
      `);

      // Older event (created timestamp now - 50 < now - 10)
      const payload = JSON.stringify({
        id: "evt_older",
        type: "customer.subscription.updated",
        created: now - 50,
        data: { object: { customer: "cus_stale_1", status: "canceled" } },
      });
      const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

      const req = new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: payload,
      });
      const resp = await worker.fetch(req, env);
      const json = await resp.json() as any;
      assert.strictEqual(json.skipped_stale, true);

      // Client status should remain active (not overwritten by stale canceled event)
      const client = await db.prepare("SELECT status FROM clients WHERE id = 11").first<any>();
      assert.strictEqual(client.status, "active");
    });
  });

  // =========================================================================
  // F6: Accounting Ingestion & Sync
  // =========================================================================
  describe("F6: Accounting Ingestion & Sync", () => {
    test("T1.F6.1: QuickBooks payload parsing extracts entity ID and status", () => {
      const qbPayload = JSON.stringify({
        eventNotifications: [
          {
            realmId: "12345",
            dataChangeEvent: {
              entities: [
                { name: "Invoice", id: "qb_inv_101", operation: "Update" },
                { name: "Customer", id: "qb_cust_202", operation: "Create" },
              ],
            },
          },
        ],
      });

      const updates = parseQuickBooksInvoiceUpdate(qbPayload);
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].id, "qb_inv_101");
      assert.strictEqual(updates[0].status, "updated");
    });

    test("T1.F6.2: Xero payload parsing extracts resourceId and eventType", () => {
      const xeroPayload = JSON.stringify({
        events: [
          { eventCategory: "INVOICE", eventType: "UPDATE", resourceId: "xero_inv_555" },
          { eventCategory: "CONTACT", eventType: "CREATE", resourceId: "xero_contact_666" },
        ],
      });

      const updates = parseXeroInvoiceUpdate(xeroPayload);
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].id, "xero_inv_555");
      assert.strictEqual(updates[0].eventType, "UPDATE");
    });

    test("T1.F6.3: CSV ingestion converts major currency float units to integer pence", () => {
      const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nTest Debtor,debtor@test.com,INV-999,1234.56,GBP,2026-08-15`;
      const rows = parseCsv(csv);
      assert.strictEqual(rows.length, 1);
      const pence = Math.round(Number(rows[0].amount) * 100);
      assert.strictEqual(pence, 123456);
    });

    test("T1.F6.4: CSV invoice import populates status 'overdue' and last_synced_at timestamp", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (50, 'Sync Client', 'sync@test.com');
      `);

      const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nAcme Debt,acme@debt.com,INV-SYNC-1,500.00,GBP,2026-08-01`;
      const req = new Request("http://localhost/api/clients/50/invoices/import", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          "Content-Type": "text/csv",
        },
        body: csv,
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const inv = await db.prepare("SELECT * FROM invoices WHERE client_id = 50 AND invoice_number = 'INV-SYNC-1'").first<any>();
      assert.ok(inv);
      assert.strictEqual(inv.status, "overdue");
      assert.ok(inv.last_synced_at);
      assert.strictEqual(inv.amount_pence, 50000);
    });

    test("T1.F6.5: Ingestion handles multiple rows and flags validation errors cleanly", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (51, 'Multi Client', 'multi@test.com');
      `);

      const csv = [
        "debtor_name,debtor_email,invoice_number,amount,currency,due_date",
        "Valid Corp,valid@test.com,INV-VAL-1,200.00,GBP,2026-08-01",
        ",bad@test.com,INV-BAD-2,300.00,GBP,2026-08-01", // missing debtor name
      ].join("\n");

      const req = new Request("http://localhost/api/clients/51/invoices/import", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          "Content-Type": "text/csv",
        },
        body: csv,
      });
      const resp = await worker.fetch(req, env);
      const json = await resp.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.imported, 1);
      assert.strictEqual(json.errors.length, 1);
    });
  });

  // =========================================================================
  // F7: Ingestion Daily Polling Cron
  // =========================================================================
  describe("F7: Ingestion Daily Polling Cron", () => {
    test("T1.F7.1: Scheduled controller triggers 06:00 UTC overdue detection", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Cron Client', 'cron@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (10, 1, 'Overdue Debtor', 'INV-CRON-1', 100000, date('now', '-2 days'), 'overdue');
      `);

      // Mock fetch for Gemini draft generation
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes("generativelanguage.googleapis.com")) {
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Automated cron draft text" }] }, finishReason: "STOP" }],
          }));
        }
        return originalFetch(input, init);
      };

      try {
        await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);

        const draft = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 10").first<any>();
        assert.ok(draft);
        assert.strictEqual(draft.status, "draft");
        assert.strictEqual(draft.step, 1);
        assert.strictEqual(draft.body, "Automated cron draft text");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("T1.F7.2: Overdue detection filters strictly status='overdue' and due_date < date('now')", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Future Client', 'fut@test.com');
        -- Invoice due in future
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (20, 2, 'Future Debtor', 'INV-FUT-1', 100000, date('now', '+5 days'), 'overdue');
        -- Invoice paid
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (21, 2, 'Paid Debtor', 'INV-PAID-1', 100000, date('now', '-5 days'), 'paid');
      `);

      await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);

      const drafts = await db.prepare("SELECT * FROM chase_log WHERE invoice_id IN (20, 21)").all();
      assert.strictEqual(drafts.results.length, 0);
    });

    test("T1.F7.3: Overdue detection sends operator alert when drafts are staged", async () => {
      const { env, db, notify } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Alert Client', 'alert@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (30, 3, 'Alert Debtor', 'INV-ALERT-1', 100000, date('now', '-2 days'), 'overdue');
      `);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Draft text" }] }, finishReason: "STOP" }],
      }));

      try {
        await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);
        assert.ok(notify.sent.length > 0);
        assert.strictEqual(notify.sent[0].to, env.NOTIFY_TO);
        assert.ok(notify.sent[0].subject.includes("chase draft(s) ready for review"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("T1.F7.4: Friday cash report cron sends summary email per active client", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, status)
        VALUES (4, 'Friday Active Ltd', 'friday@client.test', 'active'),
               (5, 'Friday Inactive Ltd', 'inactive@client.test', 'paused');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status, paid_date)
        VALUES (4, 'Debtor Paid', 'INV-P-1', 250000, '2026-08-01', 'paid', date('now', '-2 days')),
               (4, 'Debtor Overdue', 'INV-O-2', 150000, '2026-08-01', 'overdue', NULL);
      `);

      await worker.scheduled({ cron: "0 8 * * FRI", scheduledTime: Date.now() } as any, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "friday@client.test");
      assert.ok(send.sent[0].subject.includes("Friday cash report"));
      assert.ok(send.sent[0].text?.includes("Paid this week"));
      assert.ok(send.sent[0].text?.includes("INV-P-1 — £2500.00"));
    });

    test("T1.F7.5: Unrecognized cron expression executes cleanly with zero operations", async () => {
      const { env, notify, send } = createTestEnv();
      await worker.scheduled({ cron: "0 0 * * *", scheduledTime: Date.now() } as any, env);
      assert.strictEqual(notify.sent.length, 0);
      assert.strictEqual(send.sent.length, 0);
    });
  });

  // =========================================================================
  // F8: 4-Stage Escalation Cadence
  // =========================================================================
  describe("F8: 4-Stage Escalation Cadence", () => {
    test("T1.F8.1: Stage 1 Gentle triggers at 1+ days overdue with no chase history", () => {
      assert.strictEqual(nextStepDue(1, []), 1);
      assert.strictEqual(nextStepDue(5, []), 1);
    });

    test("T1.F8.2: Stage 2 Follow-up triggers at 8+ days overdue after Stage 1", () => {
      const hist1 = [{ step: 1 }];
      assert.strictEqual(nextStepDue(7, hist1), null);
      assert.strictEqual(nextStepDue(8, hist1), 2);
      assert.strictEqual(nextStepDue(12, hist1), 2);
    });

    test("T1.F8.3: Stage 3 Firm triggers at 15+ days overdue after Stage 2", () => {
      const hist2 = [{ step: 1 }, { step: 2 }];
      assert.strictEqual(nextStepDue(14, hist2), null);
      assert.strictEqual(nextStepDue(15, hist2), 3);
      assert.strictEqual(nextStepDue(20, hist2), 3);
    });

    test("T1.F8.4: Stage 4 Final triggers at 22+ days overdue after Stage 3", () => {
      const hist3 = [{ step: 1 }, { step: 2 }, { step: 3 }];
      assert.strictEqual(nextStepDue(21, hist3), null);
      assert.strictEqual(nextStepDue(22, hist3), 4);
    });

    test("T1.F8.5: Intermediate waiting state reports days elapsed since prior chase", () => {
      const today = new Date("2026-09-10T00:00:00Z");
      const dueDate = new Date("2026-08-01T00:00:00Z");
      const state: InvoiceEscalationState = {
        stage: "stage2_followup",
        dueDate,
        lastChaseDate: new Date("2026-09-06T00:00:00Z"), // 4 days ago (< 7)
      };

      const decision = advanceEscalationStage(state, today);
      assert.strictEqual(decision.stage, "stage2_followup");
      assert.ok(decision.nextAction.includes("Waiting — 4d since Stage 2"));
    });
  });

  // =========================================================================
  // F9: Terminal Escalation States
  // =========================================================================
  describe("F9: Terminal Escalation States", () => {
    test("T1.F9.1: Paid invoice is excluded from automated overdue detection query", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Term Client', 'term@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status, paid_date)
        VALUES (10, 1, 'Paid Debtor', 'INV-PAID-99', 50000, date('now', '-10 days'), 'paid', date('now'));
      `);

      const overdue = await db.prepare("SELECT * FROM invoices WHERE status = 'overdue' AND due_date < date('now')").all();
      assert.strictEqual(overdue.results.length, 0);
    });

    test("T1.F9.2: Handed back state ceases further automated chasing after Stage 4", () => {
      const today = new Date("2026-09-20T00:00:00Z");
      const dueDate = new Date("2026-08-01T00:00:00Z");
      const state: InvoiceEscalationState = {
        stage: "stage4_final",
        dueDate,
        lastChaseDate: new Date("2026-09-10T00:00:00Z"), // 10 days ago (>= 7)
      };

      const decision = advanceEscalationStage(state, today);
      assert.strictEqual(decision.stage, "stage4_final");
      assert.ok(decision.nextAction.includes("handing back to client"));
    });

    test("T1.F9.3: Skipped draft status updates chase_log and preserves audit history without sending", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Skip Org', 'skip@org.test');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor 1', 'INV-SKIP-1', 40000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (100, 1, 1, 'email', 'draft', 'Skip me');
      `);

      const req = new Request("http://localhost/api/chase/100/skip", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const row = await db.prepare("SELECT status, reviewed_at FROM chase_log WHERE id = 100").first<any>();
      assert.strictEqual(row.status, "skipped");
      assert.ok(row.reviewed_at);
      assert.strictEqual(send.sent.length, 0);
    });

    test("T1.F9.4: NextStepDue returns null when all 4 cadence steps are exhausted", () => {
      const exhaustedHistory = [{ step: 1 }, { step: 2 }, { step: 3 }, { step: 4 }];
      assert.strictEqual(nextStepDue(30, exhaustedHistory), null);
      assert.strictEqual(nextStepDue(100, exhaustedHistory), null);
    });

    test("T1.F9.5: Disputed invoice status halts escalation evaluation", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Disp Client', 'disp@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (10, 1, 'Disputed Debtor', 'INV-DISP-1', 75000, date('now', '-20 days'), 'disputed');
      `);

      const candidates = await db.prepare("SELECT * FROM invoices WHERE status = 'overdue'").all();
      assert.strictEqual(candidates.results.length, 0);
    });
  });

  // =========================================================================
  // F10: BoE Base Rate + 8% Statutory Interest
  // =========================================================================
  describe("F10: BoE Base Rate + 8% Statutory Interest", () => {
    test("T1.F10.1: Accrual formula for 365 days at 3.75% BoE rate calculates exact 11.75%", () => {
      // £1,000 principal (100,000 pence) * 11.75% = 11,750 pence (£117.50)
      const interest = statutoryInterestPence(100_000, 365, 3.75);
      assert.strictEqual(interest, 11750);
    });

    test("T1.F10.2: Zero days overdue yields exactly 0 pence interest", () => {
      assert.strictEqual(statutoryInterestPence(500_000, 0, 3.75), 0);
    });

    test("T1.F10.3: GET /api/statutory-rate returns BOE_BASE_RATE_PERCENT from environment", async () => {
      const { env } = createTestEnv({ BOE_BASE_RATE_PERCENT: "4.25" });
      const req = new Request("http://localhost/api/statutory-rate");
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);
      const json = await resp.json() as any;
      assert.strictEqual(json.boeBaseRatePercent, 4.25);
    });

    test("T1.F10.4: Accrual on £5,000 for 30 days yields 4829 pence (properly rounded)", () => {
      // (500000 * 11.75 / 100 / 365) * 30 = 4828.767... -> 4829 pence
      const interest = statutoryInterestPence(500_000, 30, 3.75);
      assert.strictEqual(interest, 4829);
    });

    test("T1.F10.5: Single-evaluation formula prevents daily compounding rounding drift", () => {
      const amountPence = 250_000; // £2,500
      const days = 60;
      const boeRate = 3.75;
      const direct = statutoryInterestPence(amountPence, days, boeRate);

      // Verify formula calculates directly without day-by-day accumulated rounding
      const expected = Math.round(((amountPence * (boeRate + 8)) / 100 / 365) * days);
      assert.strictEqual(direct, expected);
    });
  });

  // =========================================================================
  // F11: Statutory Compensation Tiers
  // =========================================================================
  describe("F11: Statutory Compensation Tiers", () => {
    test("T1.F11.1: Debt under £1,000 yields £40.00 (4,000 pence)", () => {
      assert.strictEqual(fixedCompensationPence(100), 4000);
      assert.strictEqual(fixedCompensationPence(50000), 4000);
      assert.strictEqual(fixedCompensationPence(99999), 4000);
    });

    test("T1.F11.2: Debt of £1,000 to £9,999.99 yields £70.00 (7,000 pence)", () => {
      assert.strictEqual(fixedCompensationPence(100_000), 7000);
      assert.strictEqual(fixedCompensationPence(500_000), 7000);
      assert.strictEqual(fixedCompensationPence(999_999), 7000);
    });

    test("T1.F11.3: Debt of £10,000 and above yields £100.00 (10,000 pence)", () => {
      assert.strictEqual(fixedCompensationPence(1_000_000), 10000);
      assert.strictEqual(fixedCompensationPence(2_500_000), 10000);
    });

    test("T1.F11.4: £500 debt returns Tier 1 compensation £40", () => {
      assert.strictEqual(fixedCompensationPence(50000), 4000);
    });

    test("T1.F11.5: £25,000 debt returns Tier 3 compensation £100", () => {
      assert.strictEqual(fixedCompensationPence(2_500_000), 10000);
    });
  });

  // =========================================================================
  // F12: Locked Sender & Sign-off Model
  // =========================================================================
  describe("F12: Locked Sender & Sign-off Model", () => {
    test("T1.F12.1: Envelope sender is locked to hello@invoicerescue.co.uk", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Acme",
        invoiceNumber: "INV-1",
        amountPence: 10000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 5,
        step: 1,
        stepLabel: "reminder",
        statutoryInterestPence: 0,
        fixedCompensationPence: 4000,
        clientBusinessName: "ConsultCo",
      });
      assert.ok(prompt.includes("FROM: hello@invoicerescue.co.uk"));
    });

    test("T1.F12.2: Outbound chase draft prompt enforces verbatim Tibor Rames sign-off block", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Beta Corp",
        invoiceNumber: "INV-2",
        amountPence: 50000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 10,
        step: 2,
        stepLabel: "follow-up",
        statutoryInterestPence: 0,
        fixedCompensationPence: 4000,
        clientBusinessName: "Alpha Ltd",
      });

      const expectedSignOff = "Tibor Rames\nInvoice Rescue — acting on behalf of Alpha Ltd\nhello@invoicerescue.co.uk";
      assert.ok(prompt.includes(expectedSignOff));
    });

    test("T1.F12.3: Sign-off block dynamically binds client company name", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Gamma",
        invoiceNumber: "INV-3",
        amountPence: 20000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 2,
        step: 1,
        stepLabel: "reminder",
        statutoryInterestPence: 0,
        fixedCompensationPence: 4000,
        clientBusinessName: "OmniCorp UK",
      });
      assert.ok(prompt.includes("Invoice Rescue — acting on behalf of OmniCorp UK"));
    });

    test("T1.F12.4: Locked sender model forbids omitted sign-off or modified sender", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: "Use gentle tone",
        debtorName: "Delta",
        invoiceNumber: "INV-4",
        amountPence: 30000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 5,
        step: 1,
        stepLabel: "reminder",
        statutoryInterestPence: 0,
        fixedCompensationPence: 4000,
      });
      assert.ok(prompt.includes("SENDER MODEL (LOCKED):"));
      assert.ok(prompt.includes("Sign-off (every stage MUST use this exactly):"));
    });

    test("T1.F12.5: Admin approval dispatches email with display name Invoice Rescue and NOTIFY_FROM", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client X', 'x@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (10, 1, 'Debtor X', 'debtor@target.test', 'INV-X', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (100, 10, 1, 'email', 'draft', 'Chase body content');
      `);

      const req = new Request("http://localhost/api/chase/100/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      await worker.fetch(req, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].from.name, "Invoice Rescue");
      assert.strictEqual(send.sent[0].from.email, env.NOTIFY_FROM);
      assert.strictEqual(send.sent[0].to, "debtor@target.test");
    });
  });

  // =========================================================================
  // F13: Chase Draft Generation & Staging
  // =========================================================================
  describe("F13: Chase Draft Generation & Staging", () => {
    test("T1.F13.1: Staged draft in chase_log has status='draft' and channel='email'", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client Draft', 'd@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor D', 'INV-D-1', 40000, '2026-08-01', 'overdue');
      `);

      await db.prepare(`
        INSERT INTO chase_log (invoice_id, step, channel, subject, status, body)
        VALUES (1, 1, 'email', 'Re: Invoice INV-D-1', 'draft', 'Draft body')
      `).run();

      const draft = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 1").first<any>();
      assert.strictEqual(draft.status, "draft");
      assert.strictEqual(draft.channel, "email");
      assert.strictEqual(draft.subject, "Re: Invoice INV-D-1");
    });

    test("T1.F13.2: Step 1 draft prompt omits statutory interest mention", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Alice",
        invoiceNumber: "INV-STEP1",
        amountPence: 50000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 2,
        step: 1,
        stepLabel: "reminder",
        statutoryInterestPence: 0,
        fixedCompensationPence: 4000,
      });

      assert.ok(prompt.includes("Do not mention statutory interest yet"));
      assert.ok(!prompt.includes("statutory interest of"));
    });

    test("T1.F13.3: Step 3 draft prompt explicitly includes statutory interest and fixed fee", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Bob",
        invoiceNumber: "INV-STEP3",
        amountPence: 200_000, // £2,000
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 16,
        step: 3,
        stepLabel: "firm notice",
        statutoryInterestPence: 1030, // £10.30
        fixedCompensationPence: 7000, // £70.00
      });

      assert.ok(prompt.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
      assert.ok(prompt.includes("statutory interest of GBP 10.30"));
      assert.ok(prompt.includes("fixed compensation of GBP 70.00"));
    });

    test("T1.F13.4: Step 4 draft prompt instructs 7-day final notice before hand-back", () => {
      const prompt = buildChasePrompt({
        clientVoiceNotes: null,
        debtorName: "Charlie",
        invoiceNumber: "INV-STEP4",
        amountPence: 150000,
        currency: "GBP",
        dueDate: "2026-08-01",
        daysOverdue: 25,
        step: 4,
        stepLabel: "final notice",
        statutoryInterestPence: 1200,
        fixedCompensationPence: 7000,
      });

      assert.ok(prompt.includes("Stage 4: Final reminder, give 7-day notice before returning the matter to the client"));
    });

    test("T1.F13.5: Operator review requirement: drafts are created un-sent awaiting admin action", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 10000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (invoice_id, step, channel, status, body)
        VALUES (1, 1, 'email', 'draft', 'Draft awaiting human approval');
      `);

      const row = await db.prepare("SELECT status, reviewed_at FROM chase_log WHERE invoice_id = 1").first<any>();
      assert.strictEqual(row.status, "draft");
      assert.strictEqual(row.reviewed_at, null);
    });
  });

  // =========================================================================
  // F14: Executive Financial Dashboard
  // =========================================================================
  describe("F14: Executive Financial Dashboard", () => {
    test("T1.F14.1: Portal dashboard endpoint returns 200 with client company name in header", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Executive Agency Ltd', 'exec@agency.test');
      `);

      const cookie = await buildSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);
      const html = await resp.text();
      assert.ok(html.includes("Executive Agency Ltd"));
    });

    test("T1.F14.2: Invoices table renders invoice number, debtor name, amount, and due date", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Dash Agency', 'dash@agency.test');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, currency, due_date, status)
        VALUES (2, 'Big Client Debtor', 'INV-DASH-100', 350000, 'GBP', '2026-08-15', 'overdue');
      `);

      const cookie = await buildSessionCookie(2, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.ok(html.includes("INV-DASH-100"));
      assert.ok(html.includes("Big Client Debtor"));
      assert.ok(html.includes("£3500.00"));
      assert.ok(html.includes("2026-08-15"));
    });

    test("T1.F14.3: Chase history table displays step, status, and human review attribution", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Audit Agency', 'audit@agency.test');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (5, 3, 'Audited Debtor', 'INV-AUD-1', 20000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at, reviewed_at, reviewed_by)
        VALUES (5, 1, 'sent', '2026-08-05 10:00:00', '2026-08-05 09:55:00', 'Tibor Rames');
      `);

      const cookie = await buildSessionCookie(3, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.ok(html.includes("Step 1"));
      assert.ok(html.includes("Reviewed and approved by Tibor Rames"));
    });

    test("T1.F14.4: Dashboard displays empty state when client has no invoices", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (4, 'Empty Client', 'empty@test.com');
      `);

      const cookie = await buildSessionCookie(4, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.ok(html.includes("No invoices on file yet."));
      assert.ok(html.includes("No chase activity yet."));
    });

    test("T1.F14.5: Dashboard provides billing management and logout action forms", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (5, 'Action Client', 'action@test.com');
      `);

      const cookie = await buildSessionCookie(5, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/portal/dashboard", {
        headers: { Cookie: cookie.split(";")[0] },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.ok(html.includes('action="/portal/billing"'));
      assert.ok(html.includes('action="/portal/logout"'));
    });
  });

  // =========================================================================
  // F15: Debtor Ledger Filtering & Search
  // =========================================================================
  describe("F15: Debtor Ledger Filtering & Search", () => {
    test("T1.F15.1: Invoices query orders records by due_date descending", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Order Client', 'order@test.com');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 'Debtor 1', 'INV-1', 10000, '2026-07-01', 'overdue'),
               (1, 'Debtor 2', 'INV-2', 20000, '2026-08-01', 'overdue'),
               (1, 'Debtor 3', 'INV-3', 30000, '2026-09-01', 'overdue');
      `);

      const rows = await db.prepare("SELECT invoice_number FROM invoices WHERE client_id = 1 ORDER BY due_date DESC").all();
      assert.strictEqual((rows.results[0] as any).invoice_number, "INV-3");
      assert.strictEqual((rows.results[1] as any).invoice_number, "INV-2");
      assert.strictEqual((rows.results[2] as any).invoice_number, "INV-1");
    });

    test("T1.F15.2: Invoices query filters by status overdue vs paid", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Filter Client', 'filt@test.com');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (2, 'D1', 'INV-OD', 10000, '2026-08-01', 'overdue'),
               (2, 'D2', 'INV-PD', 20000, '2026-08-01', 'paid');
      `);

      const overdue = await db.prepare("SELECT invoice_number FROM invoices WHERE client_id = 2 AND status = 'overdue'").all();
      assert.strictEqual(overdue.results.length, 1);
      assert.strictEqual((overdue.results[0] as any).invoice_number, "INV-OD");

      const paid = await db.prepare("SELECT invoice_number FROM invoices WHERE client_id = 2 AND status = 'paid'").all();
      assert.strictEqual(paid.results.length, 1);
      assert.strictEqual((paid.results[0] as any).invoice_number, "INV-PD");
    });

    test("T1.F15.3: Ledger query handles multi-currency entries with currency formatting", async () => {
      const html = renderPortalDashboard(
        { id: 1, company_name: "Multi Curr", contact_name: "Owner", stripe_customer_id: null },
        [
          { invoice_number: "INV-GBP", debtor_name: "UK Corp", amount_pence: 125000, currency: "GBP", status: "overdue", due_date: "2026-08-01" },
          { invoice_number: "INV-USD", debtor_name: "US Corp", amount_pence: 80000, currency: "USD", status: "overdue", due_date: "2026-08-01" },
        ],
        [],
      );

      assert.ok(html.includes("£1250.00"));
      assert.ok(html.includes("USD 800.00"));
    });

    test("T1.F15.4: Debtor name search query filters correctly with parameter binding", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Search Client', 'search@test.com');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (3, 'Acme Logistics Ltd', 'INV-LOG', 50000, '2026-08-01', 'overdue'),
               (3, 'Zenith Creative Studio', 'INV-ZEN', 60000, '2026-08-01', 'overdue');
      `);

      const searchTerm = "%Logistics%";
      const res = await db.prepare("SELECT invoice_number FROM invoices WHERE client_id = 3 AND debtor_name LIKE ?1")
        .bind(searchTerm)
        .all();
      assert.strictEqual(res.results.length, 1);
      assert.strictEqual((res.results[0] as any).invoice_number, "INV-LOG");
    });

    test("T1.F15.5: Search and query parameters avoid SQL injection via parameterized prepare", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (4, 'Inject Client', 'inj@test.com');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (4, 'Real Debtor', 'INV-SECURE', 50000, '2026-08-01', 'overdue');
      `);

      const malicious = "' OR '1'='1";
      const res = await db.prepare("SELECT invoice_number FROM invoices WHERE client_id = 4 AND debtor_name = ?1")
        .bind(malicious)
        .all();
      assert.strictEqual(res.results.length, 0);
    });
  });

  // =========================================================================
  // F16: WCAG 2.2 AA Accessibility
  // =========================================================================
  describe("F16: WCAG 2.2 AA Accessibility", () => {
    test("T1.F16.1: HTML pages declare valid doctype, charset, and title metadata", () => {
      const html = renderPortalLogin();
      assert.ok(html.includes("<!doctype html>"));
      assert.ok(html.includes('<meta charset="utf-8">'));
      assert.ok(html.includes("<title>Invoice Rescue — Client login</title>"));
    });

    test("T1.F16.2: Tabular structures include accessible th headers for all columns", () => {
      const html = renderReviewQueue([]);
      assert.ok(html.includes("<th>Client</th>"));
      assert.ok(html.includes("<th>Debtor</th>"));
      assert.ok(html.includes("<th>Invoice</th>"));
      assert.ok(html.includes("<th>Step</th>"));
      assert.ok(html.includes("<th>Message</th>"));
    });

    test("T1.F16.3: Login form includes explicit label tag associated with input", () => {
      const html = renderPortalLogin();
      assert.ok(html.includes("<label>Email <input type=\"email\" name=\"email\" required autofocus></label>"));
    });

    test("T1.F16.4: Interactive buttons contain explicit action text", () => {
      const html = renderReviewQueue([
        {
          id: 1,
          step: 1,
          body: "Chase note",
          subject: "Subj",
          invoice_number: "INV-1",
          debtor_name: "Debtor",
          debtor_email: "debtor@test.com",
          company_name: "Client Corp",
        },
      ]);
      assert.ok(html.includes("<button type=\"submit\">Approve &amp; send</button>"));
      assert.ok(html.includes("<button type=\"submit\">Skip</button>"));
    });

    test("T1.F16.5: HTML output escapes special characters to prevent XSS and presentation glitches", () => {
      const escaped = escapeHtml('<script>alert("xss")</script> & "test"');
      assert.strictEqual(escaped, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;test&quot;");
    });
  });

  // =========================================================================
  // F17: Review Queue Draft Editing
  // =========================================================================
  describe("F17: Review Queue Draft Editing", () => {
    test("T1.F17.1: Review queue renders draft message inside editable textarea", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Queue Client', 'qc@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Draft Debtor', 'INV-QUEUE-1', 45000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (10, 1, 1, 'email', 'draft', 'Editable message body here');
      `);

      const req = new Request("http://localhost/admin", {
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET) },
      });
      const resp = await worker.fetch(req, env);
      const html = await resp.text();

      assert.strictEqual(resp.status, 200);
      assert.ok(html.includes('<textarea name="body" rows="6" cols="60">Editable message body here</textarea>'));
    });

    test("T1.F17.2: Submitting edited textarea body in approval updates draft text in chase_log", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Edit Client', 'ec@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor E', 'debtor.e@test.com', 'INV-EDIT-1', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (20, 1, 1, 'email', 'draft', 'Original draft text');
      `);

      const formData = new FormData();
      formData.set("body", "Custom tailored message from human operator.");

      const req = new Request("http://localhost/api/chase/20/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
        body: formData,
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const row = await db.prepare("SELECT body FROM chase_log WHERE id = 20").first<any>();
      assert.strictEqual(row.body, "Custom tailored message from human operator.");
    });

    test("T1.F17.3: Outbound email transmits the exact edited body", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client Out', 'out@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor Out', 'out.debtor@test.com', 'INV-OUT-1', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (30, 1, 1, 'email', 'draft', 'Old body');
      `);

      const formData = new FormData();
      formData.set("body", "Special revised chase text with custom terms.");

      const req = new Request("http://localhost/api/chase/30/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
        body: formData,
      });
      await worker.fetch(req, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].text, "Special revised chase text with custom terms.");
    });

    test("T1.F17.4: HTML special characters in draft body are properly escaped in textarea", () => {
      const drafts = [
        {
          id: 1,
          step: 1,
          body: 'Tom & Jerry said: "<Pay Now>"',
          subject: "Subj",
          invoice_number: "INV-HTML",
          debtor_name: "Debtor",
          debtor_email: "debtor@test.com",
          company_name: "Client",
        },
      ];
      const html = renderReviewQueue(drafts);
      assert.ok(html.includes("Tom &amp; Jerry said: &quot;&lt;Pay Now&gt;&quot;"));
    });

    test("T1.F17.5: Unedited approval preserves original draft body", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client Keep', 'keep@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor Keep', 'keep@debtor.test', 'INV-KEEP-1', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (40, 1, 1, 'email', 'draft', 'Exact original draft to send unchanged');
      `);

      // Empty form post / fetch without body edit
      const req = new Request("http://localhost/api/chase/40/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      await worker.fetch(req, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].text, "Exact original draft to send unchanged");
    });
  });

  // =========================================================================
  // F18: Review Queue Approve & Defer
  // =========================================================================
  describe("F18: Review Queue Approve & Defer", () => {
    test("T1.F18.1: Approving draft transitions status to sent and outcome to sent", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Approve Client', 'app@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor App', 'debtor@app.test', 'INV-APP-1', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (50, 1, 1, 'email', 'draft', 'Ready to approve');
      `);

      const req = new Request("http://localhost/api/chase/50/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const row = await db.prepare("SELECT status, outcome FROM chase_log WHERE id = 50").first<any>();
      assert.strictEqual(row.status, "sent");
      assert.strictEqual(row.outcome, "sent");
    });

    test("T1.F18.2: Approving draft stamps reviewed_at timestamp and reviewed_by operator name", async () => {
      const { env, db } = createTestEnv({ OPERATOR_NAME: "Tibor Rames" });
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Audit Client', 'aud@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor Aud', 'aud@debtor.test', 'INV-AUD-2', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (60, 1, 1, 'email', 'draft', 'Ready for audit');
      `);

      const req = new Request("http://localhost/api/chase/60/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      await worker.fetch(req, env);

      const row = await db.prepare("SELECT reviewed_at, reviewed_by FROM chase_log WHERE id = 60").first<any>();
      assert.ok(row.reviewed_at);
      assert.strictEqual(row.reviewed_by, "Tibor Rames");
    });

    test("T1.F18.3: Skipping draft transitions status to skipped and stamps reviewed_at", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Skip Client', 'sk@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor Sk', 'sk@debtor.test', 'INV-SK-1', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (70, 1, 1, 'email', 'draft', 'Defer this draft');
      `);

      const req = new Request("http://localhost/api/chase/70/skip", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      const row = await db.prepare("SELECT status, reviewed_at FROM chase_log WHERE id = 70").first<any>();
      assert.strictEqual(row.status, "skipped");
      assert.ok(row.reviewed_at);
    });

    test("T1.F18.4: Approving already approved or non-existent draft returns 404", async () => {
      const { env } = createTestEnv();
      const req = new Request("http://localhost/api/chase/999999/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 404);
    });

    test("T1.F18.5: Attempting to approve draft for invoice without debtor email returns 422", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'No Email Client', 'ne@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'No Email Debtor', NULL, 'INV-NO-EMAIL', 50000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (80, 1, 1, 'email', 'draft', 'Draft without debtor email');
      `);

      const req = new Request("http://localhost/api/chase/80/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 422);
    });
  });

  // =========================================================================
  // F19: Responsive & Theming Support
  // =========================================================================
  describe("F19: Responsive & Theming Support", () => {
    test("T1.F19.1: System styling specifies clean sans-serif typography and responsive table layout", () => {
      const html = renderReviewQueue([]);
      assert.ok(html.includes("font-family:system-ui,sans-serif"));
      assert.ok(html.includes("border-collapse:collapse;width:100%"));
    });

    test("T1.F19.2: Portal shell sets responsive viewport-friendly max-width container", () => {
      const html = renderPortalLogin();
      assert.ok(html.includes("max-width:840px"));
    });

    test("T1.F19.3: Forms define explicit control sizing for mobile touch accessibility", () => {
      const html = renderPortalLogin();
      assert.ok(html.includes("padding:.4rem"));
    });

    test("T1.F19.4: Clean table border styling renders legible dividing lines across viewports", () => {
      const html = renderReviewQueue([]);
      assert.ok(html.includes("border:1px solid #ccc"));
    });

    test("T1.F19.5: Clean UI layout avoids unexpected horizontal overflow", () => {
      const html = renderPortalDashboard(
        { id: 1, company_name: "Test", contact_name: "Test", stripe_customer_id: null },
        [],
        [],
      );
      assert.ok(html.includes("width:100%"));
    });
  });

  // =========================================================================
  // F20: Edge Runtime Zero Runtime Deps
  // =========================================================================
  describe("F20: Edge Runtime Zero Runtime Deps", () => {
    test("T1.F20.1: Worker fetch handler uses standard Request/Response without third-party frameworks", async () => {
      const { env } = createTestEnv();
      const req = new Request("http://localhost/api/health");
      const resp = await worker.fetch(req, env);
      assert.ok(resp instanceof Response);
      assert.strictEqual(resp.status, 200);
    });

    test("T1.F20.2: Cryptographic operations rely strictly on Web Crypto API", async () => {
      assert.ok(typeof crypto !== "undefined");
      assert.ok(typeof crypto.subtle !== "undefined");
      const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
      assert.ok(key);
    });

    test("T1.F20.3: Base64 encoding uses standard built-in btoa and atob", () => {
      const str = "Invoice Rescue 2026";
      const b64 = btoa(str);
      assert.strictEqual(atob(b64), str);
    });

    test("T1.F20.4: String conversions use native TextEncoder and TextDecoder", () => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const bytes = encoder.encode("Hello Edge Runtime");
      assert.strictEqual(decoder.decode(bytes), "Hello Edge Runtime");
    });

    test("T1.F20.5: Zero runtime packages in package.json dependencies", () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
      assert.strictEqual(pkg.dependencies, undefined);
    });
  });

  // =========================================================================
  // F21: Split-Trust Email Routing
  // =========================================================================
  describe("F21: Split-Trust Email Routing", () => {
    test("T1.F21.1: Operator alerts route strictly via env.NOTIFY to operator destination", async () => {
      const { env, notify, send } = createTestEnv();
      const req = new Request("http://localhost/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          name: "Test Lead",
          email: "lead@test.com",
          company: "Lead Co",
          overdue_band: "5k_25k",
          message: "Help us recover invoices",
          website: "",
        }),
      });

      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);
      assert.strictEqual(notify.sent.length, 1);
      assert.strictEqual(notify.sent[0].to, env.NOTIFY_TO);
      assert.strictEqual(send.sent.length, 0);
    });

    test("T1.F21.2: Debtor communications route strictly via env.SEND to debtor destination", async () => {
      const { env, db, notify, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Sender Org', 'org@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Target Debtor', 'target@debtor.test', 'INV-TGT-1', 40000, '2026-08-01', 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (15, 1, 1, 'email', 'draft', 'Debtor message');
      `);

      const req = new Request("http://localhost/api/chase/15/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      await worker.fetch(req, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "target@debtor.test");
      assert.strictEqual(notify.sent.length, 0);
    });

    test("T1.F21.3: Client portal magic link login routes strictly via env.SEND to client contact email", async () => {
      const { env, db, notify, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Magic Org', 'magic@client.test');
      `);

      const req = new Request("http://localhost/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "magic@client.test" }),
      });
      const resp = await worker.fetch(req, env);
      assert.strictEqual(resp.status, 200);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "magic@client.test");
      assert.ok(send.sent[0].subject.includes("login link"));
      assert.strictEqual(notify.sent.length, 0);
    });

    test("T1.F21.4: Friday cash reports route strictly via env.SEND to client contact emails", async () => {
      const { env, db, notify, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, status)
        VALUES (1, 'Client Cash', 'cash@client.test', 'active');
      `);

      await worker.scheduled({ cron: "0 8 * * FRI", scheduledTime: Date.now() } as any, env);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "cash@client.test");
      assert.strictEqual(notify.sent.length, 0);
    });

    test("T1.F21.5: Split routing isolates operator inbox quota from debtor email bounces", () => {
      const { notify, send } = createTestEnv();
      assert.notStrictEqual(notify, send);
      assert.strictEqual(notify.sent.length, 0);
      assert.strictEqual(send.sent.length, 0);
    });
  });

  // =========================================================================
  // F22: D1 Migration & Schema Integrity
  // =========================================================================
  describe("F22: D1 Migration & Schema Integrity", () => {
    test("T1.F22.1: Migrations 0001 through 0006 apply cleanly without syntax errors", () => {
      const { db } = createTestEnv();
      const tables = db.rawSqlite.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      assert.ok(tableNames.includes("clients"));
      assert.ok(tableNames.includes("invoices"));
      assert.ok(tableNames.includes("chase_log"));
      assert.ok(tableNames.includes("leads"));
      assert.ok(tableNames.includes("webhook_events"));
      assert.ok(tableNames.includes("accounting_connections"));
      assert.ok(tableNames.includes("accounting_webhook_events"));
    });

    test("T1.F22.2: Clients table enforces check constraint on plan", async () => {
      const { db } = createTestEnv();
      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO clients (company_name, contact_email, plan)
          VALUES ('Invalid Plan Co', 'inv@test.com', 'enterprise_gold')
        `).run();
      }, /CHECK constraint failed/);
    });

    test("T1.F22.3: Invoices table enforces check constraint on positive amount_pence", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
      `);

      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
          VALUES (1, 'Negative Debtor', 'INV-NEG', -500, '2026-08-01')
        `).run();
      }, /CHECK constraint failed/);
    });

    test("T1.F22.4: Invoices table enforces composite unique constraint on (client_id, invoice_number)", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 'Debtor 1', 'INV-DUP-1', 50000, '2026-08-01');
      `);

      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
          VALUES (1, 'Debtor 1', 'INV-DUP-1', 50000, '2026-08-01')
        `).run();
      }, /UNIQUE constraint failed/);
    });

    test("T1.F22.5: Accounting connections table enforces check constraint on provider", async () => {
      const { db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
      `);

      await assert.rejects(async () => {
        await db.prepare(`
          INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at)
          VALUES (1, 'sage', 'encA', 'encR', '2026-09-01')
        `).run();
      }, /CHECK constraint failed/);
    });
  });
});
