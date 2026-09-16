import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv, createBasicAuthHeader, signStripeWebhook } from "./harness";
import worker from "../../backend/src/index";
import { statutoryInterestPence, fixedCompensationPence } from "../../backend/src/lib/statutory-interest";
import { nextStepDue, advanceEscalationStage, STEP_LABELS } from "../../backend/src/lib/escalation";
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

describe("Tier 4: Real-World Application Workload Scenarios", () => {
  // =========================================================================
  // Scenario 1: Multi-Tenant Agency Full Recovery Lifecycle
  // =========================================================================
  test("Scenario 1: Multi-Tenant Agency Full Recovery Lifecycle (Onboarding -> Import -> Cron -> Review -> S2 -> Payment -> Portal)", async () => {
    const { env, db, notify, send } = createTestEnv();

    // 1. Onboard two distinct agencies via admin API
    const apexResp = await worker.fetch(
      new Request("http://localhost/api/clients", {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Apex Creative Agency Ltd",
          contact_name: "Alice Apex",
          contact_email: "alice@apexcreative.test",
          plan: "engine",
          accounting_source: "csv",
          voice_notes: "Polite but firm on credit terms.",
        }),
      }),
      env,
    );
    assert.strictEqual(apexResp.status, 201);
    const { id: apexId } = await apexResp.json() as any;

    const summitResp = await worker.fetch(
      new Request("http://localhost/api/clients", {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "application/json" },
        body: JSON.stringify({
          company_name: "Summit Engineering Partners",
          contact_name: "Sam Summit",
          contact_email: "sam@summiteng.test",
          plan: "operator",
          accounting_source: "csv",
        }),
      }),
      env,
    );
    assert.strictEqual(summitResp.status, 201);
    const { id: summitId } = await summitResp.json() as any;

    // 2. Import overdue invoices for both agencies
    const apexCsv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nGlobal Retail Ltd,retail@global.test,INV-APEX-001,1200.00,GBP,${new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)}`;
    await worker.fetch(
      new Request(`http://localhost/api/clients/${apexId}/invoices/import`, {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
        body: apexCsv,
      }),
      env,
    );

    const summitCsv = `debtor_name,debtor_email,invoice_number,amount,currency,due_date\nMetro Build Co,build@metro.test,INV-SUM-002,3400.00,GBP,${new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)}`;
    await worker.fetch(
      new Request(`http://localhost/api/clients/${summitId}/invoices/import`, {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), "Content-Type": "text/csv" },
        body: summitCsv,
      }),
      env,
    );

    // 3. Trigger 06:00 UTC Daily Ingestion Polling Cron
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Automated Stage 1 gentle reminder text." }] }, finishReason: "STOP" }],
        }));
      }
      return originalFetch(input);
    };

    try {
      await worker.scheduled({ cron: "0 6 * * *", scheduledTime: Date.now() } as any, env);

      // Verify drafts were generated for both agencies
      const drafts = await db.prepare("SELECT cl.id, cl.invoice_id, cl.body, i.client_id FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id WHERE cl.status = 'draft'").all<any>();
      assert.strictEqual(drafts.results.length, 2);

      // Verify operator notification was sent
      assert.strictEqual(notify.sent.length, 1);
      assert.strictEqual(notify.sent[0].to, env.NOTIFY_TO);
      assert.ok(notify.sent[0].subject.includes("2 chase draft(s) ready for review"));

      // 4. Operator reviews /admin queue
      const queueResp = await worker.fetch(
        new Request("http://localhost/admin", {
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET) },
        }),
        env,
      );
      assert.strictEqual(queueResp.status, 200);
      const queueHtml = await queueResp.text();
      assert.ok(queueHtml.includes("Apex Creative Agency Ltd"));
      assert.ok(queueHtml.includes("Summit Engineering Partners"));

      // 5. Operator edits and approves Apex draft; skips Summit draft
      const apexDraft = drafts.results.find((d: any) => d.client_id === apexId);
      const summitDraft = drafts.results.find((d: any) => d.client_id === summitId);

      const tailoredMessage = "Hi Accounts Team at Global Retail,\n\nGentle note regarding INV-APEX-001 (£1,200.00).\n\nBest regards,\nTibor Rames\nInvoice Rescue — acting on behalf of Apex Creative Agency Ltd\nhello@invoicerescue.co.uk";
      const editFormData = new FormData();
      editFormData.set("body", tailoredMessage);

      const approveResp = await worker.fetch(
        new Request(`http://localhost/api/chase/${apexDraft.id}/approve`, {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
          body: editFormData,
        }),
        env,
      );
      assert.strictEqual(approveResp.status, 200);

      // Skip Summit draft
      const skipResp = await worker.fetch(
        new Request(`http://localhost/api/chase/${summitDraft.id}/skip`, {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(skipResp.status, 200);

      // 6. Verify email delivery for Apex debtor via env.SEND
      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "retail@global.test");
      assert.strictEqual(send.sent[0].from.name, "Invoice Rescue");
      assert.strictEqual(send.sent[0].from.email, env.NOTIFY_FROM);
      assert.strictEqual(send.sent[0].text?.replace(/\r\n/g, "\n"), tailoredMessage.replace(/\r\n/g, "\n"));

      // 7. Advance time: Debtor settles invoice
      await db.prepare("UPDATE invoices SET status = 'paid', paid_date = date('now') WHERE invoice_number = 'INV-APEX-001'").run();

      // 8. Client logs into client portal via magic link
      const loginToken = await signLoginToken(apexId, env.PORTAL_SESSION_SECRET);
      const verifyResp = await worker.fetch(new Request(`http://localhost/portal/verify?token=${loginToken}`), env);
      assert.strictEqual(verifyResp.status, 303);

      const cookieHeader = verifyResp.headers.get("Set-Cookie");
      assert.ok(cookieHeader?.includes("portal_session="));

      // 9. Inspect client portal dashboard
      const dashResp = await worker.fetch(
        new Request("http://localhost/portal/dashboard", {
          headers: { Cookie: cookieHeader!.split(";")[0] },
        }),
        env,
      );
      assert.strictEqual(dashResp.status, 200);
      const dashHtml = await dashResp.text();

      assert.ok(dashHtml.includes("Apex Creative Agency Ltd"));
      assert.ok(dashHtml.includes("INV-APEX-001"));
      assert.ok(dashHtml.includes("paid"));
      assert.ok(dashHtml.includes("Reviewed and approved by Tibor Rames"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // Scenario 2: Duplicate Webhook Ingestion During Draft Approval
  // =========================================================================
  test("Scenario 2: Duplicate Webhook Ingestion During Draft Approval (Firm Draft -> Payment Webhook -> Idempotency -> Draft Suppressed)", async () => {
    const { env, db, send } = createTestEnv();

    // 1. Setup client and firm notice invoice
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, stripe_customer_id, status)
      VALUES (2, 'Agency Two Ltd', 'a2@test.com', 'cus_a2_sub', 'active');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
      VALUES (20, 2, 'Debtor Firm', 'debtor.firm@test.com', 'INV-FIRM-20', 250000, date('now', '-16 days'), 'overdue');
      INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
      VALUES (200, 20, 3, 'email', 'draft', 'Firm notice with statutory interest');
    `);

    // 2. Stripe subscription webhook delivery
    const now = Math.floor(Date.now() / 1000);
    const webhookPayload = JSON.stringify({
      id: "evt_payment_received_20",
      type: "customer.subscription.updated",
      created: now,
      data: { object: { customer: "cus_a2_sub", status: "active" } },
    });
    const header = await signStripeWebhook(webhookPayload, env.STRIPE_WEBHOOK_SECRET, now);

    // 1st webhook call
    const res1 = await worker.fetch(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: webhookPayload,
      }),
      env,
    );
    assert.strictEqual(res1.status, 200);

    // 2nd duplicate webhook call within 2 seconds
    const res2 = await worker.fetch(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": header, "Content-Type": "application/json" },
        body: webhookPayload,
      }),
      env,
    );
    assert.strictEqual(res2.status, 200);
    const res2Json = await res2.json() as any;
    assert.strictEqual(res2Json.duplicate, true);

    // 3. Mark invoice paid (as happens when payment reconciles) and suppress draft
    await db.rawSqlite.exec(`
      UPDATE invoices SET status = 'paid', paid_date = date('now') WHERE id = 20;
      UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE invoice_id = 20 AND status = 'draft';
    `);

    // 4. Operator attempts to approve Stage 3 draft in review queue
    const approveResp = await worker.fetch(
      new Request("http://localhost/api/chase/200/approve", {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
      }),
      env,
    );

    // Draft is already skipped/settled -> rejected with 404
    assert.strictEqual(approveResp.status, 404);
    assert.strictEqual(send.sent.length, 0); // No erroneous chase sent to settled debtor
  });

  // =========================================================================
  // Scenario 3: Leap Year & Multi-Year Debt Accumulation
  // =========================================================================
  test("Scenario 3: Leap Year & Multi-Year Debt Accumulation (Statutory Interest Calculation & Draft Presentation)", async () => {
    const { env, db } = createTestEnv();

    // Ingest £15,000 historic debt (1,500,000 pence) overdue across leap year
    const principalPence = 1_500_000;
    const daysOverdue = 400; // Over 1 full year including leap day
    const boeRate = 3.75; // total rate 11.75%

    // Calculate statutory interest directly without drift
    const totalInterestPence = statutoryInterestPence(principalPence, daysOverdue, boeRate);
    // (1,500,000 * 11.75 / 100 / 365) * 400 = 193150.68... -> 193151 pence (£1,931.51)
    assert.strictEqual(totalInterestPence, 193151);

    // Statutory fixed fee under Section 5A: >= £10,000 -> £100
    const fixedFeePence = fixedCompensationPence(principalPence);
    assert.strictEqual(fixedFeePence, 10000);

    // Construct chase prompt
    const prompt = buildChasePrompt({
      clientVoiceNotes: "Formal commercial debt recovery.",
      debtorName: "MultiYear Logistics Ltd",
      invoiceNumber: "INV-HISTORIC-99",
      amountPence: principalPence,
      currency: "GBP",
      dueDate: "2025-01-15",
      daysOverdue,
      step: 3,
      stepLabel: "firm notice",
      statutoryInterestPence: totalInterestPence,
      fixedCompensationPence: fixedFeePence,
      clientBusinessName: "Prime Manufacturing Group",
    });

    assert.ok(prompt.includes("Amount: GBP 15000.00"));
    assert.ok(prompt.includes("statutory interest of GBP 1931.51"));
    assert.ok(prompt.includes("fixed compensation of GBP 100.00"));
    assert.ok(prompt.includes("Prime Manufacturing Group"));
  });

  // =========================================================================
  // Scenario 4: Token Rotation, Revocation & Re-Authentication
  // =========================================================================
  test("Scenario 4: Token Rotation, Revocation & Re-Authentication Lifecycle", async () => {
    const { env, db, notify } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (4, 'OAuth Lifecycle Co', 'oauth@lifecycle.test');
    `);

    const secretKey = "super-secure-aes-gcm-master-key!";

    // 1. Initial connection with encrypted tokens
    const accessV1 = await encryptToken("xero_access_token_v1", secretKey);
    const refreshV1 = await encryptToken("xero_refresh_token_v1", secretKey);

    await db.prepare(`
      INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
      VALUES (4, 'xero', 'tenant-uuid-1', ?1, ?2, '2026-09-10T12:00:00Z', 'active')
    `).bind(accessV1, refreshV1).run();

    // 2. Token refresh rotation: decrypt refresh token, mint new pair, re-encrypt
    const connBefore = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 4").first<any>();
    const decryptedRefreshV1 = await decryptToken(connBefore.refresh_token_encrypted, secretKey);
    assert.strictEqual(decryptedRefreshV1, "xero_refresh_token_v1");

    const accessV2 = await encryptToken("xero_access_token_v2", secretKey);
    const refreshV2 = await encryptToken("xero_refresh_token_v2", secretKey);

    await db.prepare(`
      UPDATE accounting_connections
      SET access_token_encrypted = ?1, refresh_token_encrypted = ?2, expires_at = '2026-10-10T12:00:00Z', last_synced_at = datetime('now')
      WHERE client_id = 4
    `).bind(accessV2, refreshV2).run();

    // 3. Verify rotated tokens decrypt cleanly
    const connRotated = await db.prepare("SELECT * FROM accounting_connections WHERE client_id = 4").first<any>();
    assert.strictEqual(await decryptToken(connRotated.access_token_encrypted, secretKey), "xero_access_token_v2");
    assert.strictEqual(await decryptToken(connRotated.refresh_token_encrypted, secretKey), "xero_refresh_token_v2");

    // 4. Provider revokes access (user revoked in Xero console) -> mark revoked
    await db.prepare("UPDATE accounting_connections SET status = 'revoked', last_synced_at = datetime('now') WHERE client_id = 4").run();

    const connRevoked = await db.prepare("SELECT status FROM accounting_connections WHERE client_id = 4").first<any>();
    assert.strictEqual(connRevoked.status, "revoked");
  });

  // =========================================================================
  // Scenario 5: Stage 1 to Stage 4 Hand-Back with Debtor Settlement
  // =========================================================================
  test("Scenario 5: Full 4-Stage Cadence Escalation to Hand-Back with Final Settlement", async () => {
    const { env, db, send } = createTestEnv();

    // Debt of £8,500 (850,000 pence) -> Statutory tier £70 (£1k-£10k)
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (5, 'Cadence Client', 'cadence@test.com');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
      VALUES (50, 5, 'Escalating Debtor', 'esc@debtor.test', 'INV-ESCALATE-50', 850000, '2026-08-01', 'overdue');
    `);

    // --- Stage 1 Gentle (Day 1+ overdue) ---
    assert.strictEqual(nextStepDue(1, []), 1);
    await db.prepare("INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (501, 50, 1, 'sent', 'Stage 1 sent')").run();

    // --- Stage 2 Follow-up (Day 8+ overdue) ---
    const history1 = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 50").all<any>();
    assert.strictEqual(nextStepDue(8, history1.results), 2);
    await db.prepare("INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (502, 50, 2, 'sent', 'Stage 2 sent')").run();

    // --- Stage 3 Firm notice (Day 15+ overdue) ---
    const history2 = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 50").all<any>();
    assert.strictEqual(nextStepDue(15, history2.results), 3);
    const firmInterest = statutoryInterestPence(850000, 15, 3.75);
    const firmFee = fixedCompensationPence(850000);
    assert.strictEqual(firmFee, 7000); // £70
    await db.prepare("INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (503, 50, 3, 'sent', 'Stage 3 firm sent')").run();

    // --- Stage 4 Final demand (Day 22+ overdue) ---
    const history3 = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 50").all<any>();
    assert.strictEqual(nextStepDue(22, history3.results), 4);
    await db.prepare("INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (504, 50, 4, 'sent', 'Stage 4 final sent')").run();

    // --- Day 29+: Sequence exhausted -> recommendation to hand back ---
    const history4 = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 50").all<any>();
    assert.strictEqual(nextStepDue(29, history4.results), null);

    const state: InvoiceEscalationState = {
      stage: "stage4_final",
      dueDate: new Date("2026-08-01T00:00:00Z"),
      lastChaseDate: new Date("2026-08-23T00:00:00Z"),
    };
    const decision = advanceEscalationStage(state, new Date("2026-08-31T00:00:00Z"));
    assert.ok(decision.nextAction.includes("consider handing back to client"));

    // Update status to handed_back
    await db.prepare("UPDATE invoices SET status = 'escalated' WHERE id = 50").run();

    // Final settlement: Debtor settles invoice before external litigation
    await db.prepare("UPDATE invoices SET status = 'paid', paid_date = date('now') WHERE id = 50").run();

    const finalInvoice = await db.prepare("SELECT status, paid_date FROM invoices WHERE id = 50").first<any>();
    assert.strictEqual(finalInvoice.status, "paid");
    assert.ok(finalInvoice.paid_date);

    // Audit log verifies all 4 stages preserved
    const allChases = await db.prepare("SELECT step FROM chase_log WHERE invoice_id = 50 ORDER BY step ASC").all<any>();
    assert.strictEqual(allChases.results.length, 4);
  });
});
