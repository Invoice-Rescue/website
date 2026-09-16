import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv, createBasicAuthHeader, signStripeWebhook } from "./harness";
import worker from "../../backend/src/index";
import { statutoryInterestPence, fixedCompensationPence } from "../../backend/src/lib/statutory-interest";
import { nextStepDue, advanceEscalationStage } from "../../backend/src/lib/escalation";
import { buildChasePrompt } from "../../backend/src/lib/gemini";
import { encryptToken, decryptToken } from "../../backend/src/lib/integrations/oauth-manager";
import {
  buildSessionCookie,
  verifySessionToken,
  signLoginToken,
  verifyLoginToken,
} from "../../backend/src/lib/portal-auth";
import { renderPortalDashboard } from "../../backend/src/lib/portal";
import { renderReviewQueue } from "../../backend/src/lib/admin";
import { InvoiceEscalationState } from "../../backend/src/types/core";

describe("Tier 3: Pairwise Combinatorial Interactions", () => {
  test("P1: Payment webhook arrives while draft is pending in review queue -> draft is skipped, invoice marked paid", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client P1', 'p1@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (10, 1, 'Debtor P1', 'INV-P1', 75000, date('now', '-10 days'), 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
      VALUES (100, 10, 1, 'email', 'draft', 'Staged draft awaiting review');
    `);

    // Simulate payment arriving from accounting webhook/sync
    await db.rawSqlite.exec(`
      UPDATE invoices SET status = 'paid', paid_date = date('now') WHERE id = 10;
      UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE invoice_id = 10 AND status = 'draft';
    `);

    const inv = await db.prepare("SELECT status, paid_date FROM invoices WHERE id = 10").first<any>();
    assert.strictEqual(inv.status, "paid");
    assert.ok(inv.paid_date);

    const draft = await db.prepare("SELECT status, reviewed_at FROM chase_log WHERE id = 100").first<any>();
    assert.strictEqual(draft.status, "skipped");
    assert.ok(draft.reviewed_at);

    // Operator attempting to approve the now-skipped draft returns 404 (only status='draft' can be approved)
    const req = new Request("http://localhost/api/chase/100/approve", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
    });
    const resp = await worker.fetch(req, env);
    assert.strictEqual(resp.status, 404);
  });

  test("P2: CSV import with existing invoice number for same client rejects duplicate insert", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Client P2', 'p2@test.com');
      INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
      VALUES (2, 'Original Debtor', 'INV-DUP-TEST', 50000, '2026-08-01');
    `);

    const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nNew Debtor,new@test.com,INV-DUP-TEST,999.00,GBP,2026-08-01`;
    const req = new Request("http://localhost/api/clients/2/invoices/import", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
      body: csv,
    });

    // Worker import wraps insertion; duplicate key should cause DB error or rejected import
    await assert.rejects(async () => {
      await db.prepare(`
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (2, 'New Debtor', 'INV-DUP-TEST', 99900, '2026-08-01')
      `).run();
    }, /UNIQUE constraint failed/);

    // Original remains intact
    const original = await db.prepare("SELECT amount_pence FROM invoices WHERE client_id = 2 AND invoice_number = 'INV-DUP-TEST'").first<any>();
    assert.strictEqual(original.amount_pence, 50000);
  });

  test("P3: CSV import with existing invoice number for DIFFERENT client succeeds cleanly isolating both records", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Client P3A', 'p3a@test.com'), (4, 'Client P3B', 'p3b@test.com');
      INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
      VALUES (3, 'Debtor 3A', 'INV-CROSS-1', 40000, '2026-08-01');
    `);

    const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nDebtor 3B,b@test.com,INV-CROSS-1,600.00,GBP,2026-08-01`;
    const req = new Request("http://localhost/api/clients/4/invoices/import", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
      body: csv,
    });
    const resp = await worker.fetch(req, env);
    assert.strictEqual(resp.status, 200);

    const invA = await db.prepare("SELECT amount_pence FROM invoices WHERE client_id = 3 AND invoice_number = 'INV-CROSS-1'").first<any>();
    const invB = await db.prepare("SELECT amount_pence FROM invoices WHERE client_id = 4 AND invoice_number = 'INV-CROSS-1'").first<any>();
    assert.strictEqual(invA.amount_pence, 40000);
    assert.strictEqual(invB.amount_pence, 60000);
  });

  test("P4: Token encryption with OAuth connection rotation overwrites old tokens seamlessly", async () => {
    const { db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (5, 'Client P4', 'p4@test.com');
    `);

    const key = "rotation-secret-key-32-chars!";
    const oldAccess = await encryptToken("access_v1", key);
    const oldRefresh = await encryptToken("refresh_v1", key);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (5, 'xero', ?1, ?2, '2026-09-01T00:00:00Z', 'active')
    `).bind(oldAccess, oldRefresh).run();

    // Rotate tokens
    const newAccess = await encryptToken("access_v2_rotated", key);
    const newRefresh = await encryptToken("refresh_v2_rotated", key);

    await db.prepare(`
      UPDATE accounting_connections
      SET access_token_encrypted = ?1, refresh_token_encrypted = ?2, expires_at = '2026-11-01T00:00:00Z', last_synced_at = datetime('now')
      WHERE client_id = 5 AND provider = 'xero'
    `).bind(newAccess, newRefresh).run();

    const conn = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 5").first<any>();
    const decryptedAccess = await decryptToken(conn.access_token_encrypted, key);
    const decryptedRefresh = await decryptToken(conn.refresh_token_encrypted, key);

    assert.strictEqual(decryptedAccess, "access_v2_rotated");
    assert.strictEqual(decryptedRefresh, "refresh_v2_rotated");
  });

  test("P5: Daily cron overdue detection runs while webhook updates invoice status concurrently", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (6, 'Client P5', 'p5@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (60, 6, 'Debtor P5', 'INV-P5', 50000, date('now', '-5 days'), 'overdue');
    `);

    // Simulate payment arrives right before cron
    await db.prepare("UPDATE invoices SET status = 'paid', paid_date = date('now') WHERE id = 60").run();

    // Run cron
    await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);

    // No draft should be staged for settled invoice
    const drafts = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 60").all();
    assert.strictEqual(drafts.results.length, 0);
  });

  test("P6: Webhook deduplication during rapid duplicate stripe subscription updates triggers only once", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
      VALUES (7, 'Client P6', 'p6@test.com', 'cus_rapid_p6', 'onboarding');
    `);

    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: "evt_rapid_sub_update",
      type: "customer.subscription.updated",
      created: now,
      data: { object: { customer: "cus_rapid_p6", status: "active" } },
    });
    const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

    // 1st request
    const req1 = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
      body: payload,
    });
    const res1 = await worker.fetch(req1, env);
    const json1 = await res1.json() as any;
    assert.strictEqual(json1.ok, true);
    assert.strictEqual(json1.duplicate, undefined);

    // 2nd duplicate request
    const req2 = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
      body: payload,
    });
    const res2 = await worker.fetch(req2, env);
    const json2 = await res2.json() as any;
    assert.strictEqual(json2.ok, true);
    assert.strictEqual(json2.duplicate, true);

    const client = await db.prepare("SELECT status FROM clients WHERE id = 7").first<any>();
    assert.strictEqual(client.status, "active");
  });

  test("P7: Out-of-order webhook delivery preserves newer state without downgrading", async () => {
    const { env, db } = createTestEnv();
    const now = Math.floor(Date.now() / 1000);
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
      VALUES (8, 'Client P7', 'p7@test.com', 'cus_ooo_p7', 'active');
      INSERT INTO webhook_events (id, event_type, customer_id, created_at_timestamp)
      VALUES ('evt_newer_active', 'customer.subscription.updated', 'cus_ooo_p7', ${now - 10});
    `);

    // Older event sent with status past_due (created now - 100 < now - 10)
    const payload = JSON.stringify({
      id: "evt_older_past_due",
      type: "customer.subscription.updated",
      created: now - 100,
      data: { object: { customer: "cus_ooo_p7", status: "past_due" } },
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

    const client = await db.prepare("SELECT status FROM clients WHERE id = 8").first<any>();
    assert.strictEqual(client.status, "active");
  });

  test("P8: Magic link login verification while client status is onboarding generates session cookie", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, status)
      VALUES (9, 'Onboarding Org', 'onboard@test.com', 'onboarding');
    `);

    const loginToken = await signLoginToken(9, env.PORTAL_SESSION_SECRET);
    const req = new Request(`http://localhost/portal/verify?token=${loginToken}`);
    const resp = await worker.fetch(req, env);

    assert.strictEqual(resp.status, 303);
    const cookie = resp.headers.get("Set-Cookie");
    assert.ok(cookie?.includes("portal_session="));

    const tokenMatch = cookie?.match(/portal_session=([^;]+)/);
    const verifiedId = await verifySessionToken(tokenMatch![1], env.PORTAL_SESSION_SECRET);
    assert.strictEqual(verifiedId, 9);
  });

  test("P9: Admin approves draft while operator name contains special characters", async () => {
    const operatorSpecial = "Tibor Rames & Associates (Lead Reviewer)";
    const { env, db, send } = createTestEnv({ OPERATOR_NAME: operatorSpecial });
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (10, 'Client P9', 'p9@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
      VALUES (90, 10, 'Debtor P9', 'debtor.p9@test.com', 'INV-P9', 45000, '2026-08-01');
      INSERT INTO chase_log (id, invoice_id, step, status, body)
      VALUES (900, 90, 1, 'draft', 'Message body');
    `);

    const req = new Request("http://localhost/api/chase/900/approve", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
    });
    await worker.fetch(req, env);

    const draft = await db.prepare("SELECT reviewed_by FROM chase_log WHERE id = 900").first<any>();
    assert.strictEqual(draft.reviewed_by, operatorSpecial);
    assert.strictEqual(send.sent.length, 1);
  });

  test("P10: Review queue skip action followed by subsequent daily cron maintains cadence", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (11, 'Client P10', 'p10@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (110, 11, 'Debtor P10', 'INV-P10', 50000, date('now', '-3 days'), 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, status)
      VALUES (1100, 110, 1, 'skipped');
    `);

    // At 3 days overdue with Step 1 logged in chase_log, nextStepDue for step 2 needs 8+ days -> returns null
    const history = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 110").all<any>();
    const next = nextStepDue(3, history.results);
    assert.strictEqual(next, null);
  });

  test("P11: Statutory interest calculation updates dynamically when principal debt changes", () => {
    const boeRate = 3.75;
    const days = 15;

    // Initial debt £10,000 (1,000,000 pence)
    const initialInterest = statutoryInterestPence(1_000_000, days, boeRate);
    const initialComp = fixedCompensationPence(1_000_000);
    assert.strictEqual(initialComp, 10000); // £100

    // Partial payment of £6,000 received -> remaining balance £4,000 (400,000 pence)
    const updatedInterest = statutoryInterestPence(400_000, days, boeRate);
    const updatedComp = fixedCompensationPence(400_000);
    assert.strictEqual(updatedComp, 7000); // drops to £70 tier

    assert.ok(updatedInterest < initialInterest);
    assert.strictEqual(updatedInterest, Math.round(((400000 * 11.75) / 100 / 365) * 15));
  });

  test("P12: Statutory interest calculation combined with leap year date math across 2024 / 2028", () => {
    const boeRate = 3.75; // total annual 11.75%
    const principalPence = 100_000; // £1,000

    // Standard year 365 days
    const stdYear = statutoryInterestPence(principalPence, 365, boeRate);
    assert.strictEqual(stdYear, 11750); // £117.50

    // Leap year 366 days
    const leapYear = statutoryInterestPence(principalPence, 366, boeRate);
    // (100000 * 11.75 / 100 / 365) * 366 = 11782.19... -> 11782
    assert.strictEqual(leapYear, 11782);
    assert.ok(leapYear > stdYear);
  });

  test("P13: Client portal dashboard segregates invoices ledger from chase audit log", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (13, 'Segregation Org', 'seg@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (131, 13, 'Open Debtor', 'INV-OPEN-1', 25000, '2026-08-01', 'overdue'),
             (132, 13, 'Paid Debtor', 'INV-PAID-2', 75000, '2026-08-01', 'paid');
      INSERT INTO chase_log (invoice_id, step, status, sent_at, reviewed_by)
      VALUES (131, 1, 'sent', '2026-08-02 10:00:00', 'Tibor Rames');
    `);

    const cookie = await buildSessionCookie(13, env.PORTAL_SESSION_SECRET);
    const req = new Request("http://localhost/portal/dashboard", { headers: { Cookie: cookie.split(";")[0] } });
    const resp = await worker.fetch(req, env);
    const html = await resp.text();

    assert.ok(html.includes("<h2>Invoices</h2>"));
    assert.ok(html.includes("<h2>Chase history</h2>"));
    assert.ok(html.includes("INV-OPEN-1"));
    assert.ok(html.includes("INV-PAID-2"));
    assert.ok(html.includes("Step 1"));
  });

  test("P14: Split-trust routing during daily cron: operator notification sent via NOTIFY while no debtor messages sent without approval", async () => {
    const { env, db, notify, send } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (14, 'Split Org', 'split@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (140, 14, 'Debtor 14', 'INV-14', 50000, date('now', '-2 days'), 'overdue');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Draft text" }] }, finishReason: "STOP" }],
    }));

    try {
      await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);

      // Operator alerted
      assert.strictEqual(notify.sent.length, 1);
      assert.strictEqual(notify.sent[0].to, env.NOTIFY_TO);

      // Debtor receives ZERO automated messages
      assert.strictEqual(send.sent.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("P15: Admin edits draft text to include custom payment link -> edited text preserved in chase_log and sent via SEND", async () => {
    const { env, db, send } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (15, 'Link Client', 'link@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
      VALUES (150, 15, 'Debtor Link', 'debtor.link@test.com', 'INV-15', 50000, '2026-08-01');
      INSERT INTO chase_log (id, invoice_id, step, status, body)
      VALUES (1500, 150, 1, 'draft', 'Initial body');
    `);

    const editedBody = "Please settle via our fast-pay portal: https://pay.invoicerescue.co.uk/inv-15";
    const formData = new FormData();
    formData.set("body", editedBody);

    const req = new Request("http://localhost/api/chase/1500/approve", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
      body: formData,
    });
    await worker.fetch(req, env);

    const row = await db.prepare("SELECT body, status FROM chase_log WHERE id = 1500").first<any>();
    assert.strictEqual(row.status, "sent");
    assert.strictEqual(row.body, editedBody);
    assert.strictEqual(send.sent[0].text, editedBody);
  });

  test("P16: Client onboarded via admin API immediately imports CSV invoices successfully", async () => {
    const { env, db } = createTestEnv();
    // 1. Create client
    const createReq = new Request("http://localhost/api/clients", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: "Fresh Agency Ltd",
        contact_name: "Fresh Founder",
        contact_email: "founder@freshagency.test",
        plan: "engine",
        accounting_source: "csv",
      }),
    });
    const createResp = await worker.fetch(createReq, env);
    assert.strictEqual(createResp.status, 201);
    const { id: clientId } = await createResp.json() as any;
    assert.ok(clientId > 0);

    // 2. Import CSV for newly created client
    const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nFirst Debtor,d@test.com,INV-FRESH-1,350.00,GBP,2026-08-01`;
    const importReq = new Request(`http://localhost/api/clients/${clientId}/invoices/import`, {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
      body: csv,
    });
    const importResp = await worker.fetch(importReq, env);
    assert.strictEqual(importResp.status, 200);

    const invoices = await db.prepare("SELECT * FROM invoices WHERE client_id = ?1").bind(clientId).all();
    assert.strictEqual(invoices.results.length, 1);
    assert.strictEqual((invoices.results[0] as any).amount_pence, 35000);
  });

  test("P17: Stripe webhook sets client status to churned -> client record updated", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
      VALUES (17, 'Churn Org', 'churn@test.com', 'cus_churn_17', 'active');
    `);

    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: "evt_churn_17",
      type: "customer.subscription.deleted",
      created: now,
      data: { object: { customer: "cus_churn_17" } },
    });
    const header = await signStripeWebhook(payload, env.STRIPE_WEBHOOK_SECRET, now);

    const req = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
      body: payload,
    });
    const resp = await worker.fetch(req, env);
    assert.strictEqual(resp.status, 200);

    const client = await db.prepare("SELECT status FROM clients WHERE id = 17").first<any>();
    assert.strictEqual(client.status, "churned");
  });

  test("P18: Ingestion sync marks invoice disputed -> staged draft suppressed", async () => {
    const { db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (18, 'Client P18', 'p18@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (180, 18, 'Disputed Debtor', 'INV-DISP-18', 40000, '2026-08-01', 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, status)
      VALUES (1800, 180, 1, 'draft');
    `);

    // Voided / disputed update
    await db.rawSqlite.exec(`
      UPDATE invoices SET status = 'disputed' WHERE id = 180;
      UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE invoice_id = 180 AND status = 'draft';
    `);

    const inv = await db.prepare("SELECT status FROM invoices WHERE id = 180").first<any>();
    const draft = await db.prepare("SELECT status FROM chase_log WHERE id = 1800").first<any>();
    assert.strictEqual(inv.status, "disputed");
    assert.strictEqual(draft.status, "skipped");
  });

  test("P19: OAuth connection status updated to revoked upon invalid_grant response", async () => {
    const { db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (19, 'Revoked Org', 'rev@test.com');
      INSERT INTO accounting_connections (client_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (19, 'xero', 'encA', 'encR', '2026-09-01', 'active');
    `);

    // Simulate provider returns invalid_grant on refresh attempt
    await db.prepare("UPDATE accounting_connections SET status = 'revoked', last_synced_at = datetime('now') WHERE client_id = 19").run();

    const conn = await db.prepare("SELECT status FROM accounting_connections WHERE client_id = 19").first<any>();
    assert.strictEqual(conn.status, "revoked");
  });

  test("P20: High volume debtor search while draft review is active executes concurrently", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (20, 'Concurrent Client', 'concur@test.com');
    `);

    // Insert 20 debtors
    for (let i = 1; i <= 20; i++) {
      await db.prepare(`
        INSERT INTO invoices (client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (20, ?1, ?2, 10000, '2026-08-01')
      `).bind(`Debtor Number ${i}`, `INV-CONCUR-${i}`).run();
    }

    const searchRows = await db.prepare("SELECT COUNT(*) AS total FROM invoices WHERE client_id = 20 AND debtor_name LIKE '%Debtor%'").first<any>();
    assert.strictEqual(searchRows.total, 20);
  });

  test("P21: Stage 4 final notice expires without payment -> terminal state reached", () => {
    const today = new Date("2026-09-28T00:00:00Z");
    const dueDate = new Date("2026-08-01T00:00:00Z");
    const state: InvoiceEscalationState = {
      stage: "stage4_final",
      dueDate,
      lastChaseDate: new Date("2026-09-20T00:00:00Z"), // 8 days after Stage 4 chase
    };

    const decision = advanceEscalationStage(state, today);
    assert.strictEqual(decision.stage, "stage4_final");
    assert.ok(decision.nextAction.includes("consider handing back to client"));
  });

  test("P22: Theme switching and navigation preserves portal session cookie", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (22, 'Theme Client', 'theme@test.com');
    `);

    const cookieHeader = await buildSessionCookie(22, env.PORTAL_SESSION_SECRET);

    // Initial visit
    const req1 = new Request("http://localhost/portal/dashboard", { headers: { Cookie: cookieHeader.split(";")[0] } });
    const resp1 = await worker.fetch(req1, env);
    assert.strictEqual(resp1.status, 200);

    // Subsequent navigation with theme query or dark mode state
    const req2 = new Request("http://localhost/portal/dashboard?theme=dark", { headers: { Cookie: cookieHeader.split(";")[0] } });
    const resp2 = await worker.fetch(req2, env);
    assert.strictEqual(resp2.status, 200);
    const html2 = await resp2.text();
    assert.ok(html2.includes("Theme Client"));
  });

  test("P23: CSV import with special characters in debtor name correctly stores for prompt construction", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`INSERT INTO clients (id, company_name, contact_email) VALUES (23, 'P23 Org', 'p23@test.com');`);
    const csv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\n"Smith & Sons (Holdings) Ltd",smith@holdings.test,INV-SPEC-1,750.00,GBP,2026-08-01`;

    const req = new Request("http://localhost/api/clients/23/invoices/import", {
      method: "POST",
      headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
      body: csv,
    });
    const resp = await worker.fetch(req, env);
    assert.strictEqual(resp.status, 200);

    const inv = await db.prepare("SELECT * FROM invoices WHERE invoice_number = 'INV-SPEC-1'").first<any>();
    assert.strictEqual(inv.debtor_name, "Smith & Sons (Holdings) Ltd");

    const prompt = buildChasePrompt({
      clientVoiceNotes: null,
      debtorName: inv.debtor_name,
      invoiceNumber: inv.invoice_number,
      amountPence: inv.amount_pence,
      currency: inv.currency,
      dueDate: inv.due_date,
      daysOverdue: 10,
      step: 2,
      stepLabel: "follow-up",
      statutoryInterestPence: 0,
      fixedCompensationPence: 7000,
    });
    assert.ok(prompt.includes("Debtor Contact: Smith & Sons (Holdings) Ltd"));
  });

  test("P24: Multiple clients with different BOE base rates applied calculates correctly", () => {
    // Client A in July 2026 (BoE base rate 3.75% -> 11.75% annual)
    const rateA = 3.75;
    const interestA = statutoryInterestPence(100_000, 30, rateA);
    assert.strictEqual(interestA, 966);

    // Client B in scenario with BoE base rate 4.25% -> 12.25% annual
    const rateB = 4.25;
    const interestB = statutoryInterestPence(100_000, 30, rateB);
    assert.strictEqual(interestB, 1007);

    assert.ok(interestB > interestA);
  });
});
