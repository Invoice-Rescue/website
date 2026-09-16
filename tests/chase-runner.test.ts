import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv } from "./e2e/harness";
import { runOverdueDetection, parseDate, diffDays, generateFallbackDraft } from "../backend/src/lib/chase-runner";

describe("Chase Runner: Credit-Control Escalation & Statutory Calculation Engine", () => {
  // =========================================================================
  // Requirement 1: Genuine clientBusinessName in Prompt & Sign-off
  // =========================================================================
  test("R2.1: runOverdueDetection passes genuine clientBusinessName to prompt and never falls back to [Client Business Name]", async () => {
    const { env, db } = createTestEnv();
    const testCompanyName = "Peak Velocity Solutions Ltd";
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email, voice_notes)
      VALUES (101, '${testCompanyName}', 'director@peakvelocity.co.uk', 'Direct commercial tone.');
      INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
      VALUES (1001, 101, 'Apex Industries Ltd', 'ap@apexind.co.uk', 'INV-PV-1001', 250000, 'GBP', date('now', '-3 days'), 'overdue');
    `);

    let capturedPrompt = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("generativelanguage.googleapis.com") && init?.body) {
        const bodyObj = JSON.parse(String(init.body));
        capturedPrompt = bodyObj.contents?.[0]?.parts?.[0]?.text || "";
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: `Hi Apex Industries Ltd,\n\nFriendly reminder regarding invoice INV-PV-1001.\n\nTibor Rames\nInvoice Rescue — acting on behalf of ${testCompanyName}\nhello@invoicerescue.co.uk`,
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
        );
      }
      return originalFetch(input, init);
    };

    try {
      const result = await runOverdueDetection(env);
      assert.strictEqual(result.draftsCreated, 1);

      // Verify the prompt passed to Gemini contains genuine company name and no placeholder
      assert.ok(capturedPrompt.length > 0, "Prompt must be generated and dispatched to Gemini");
      assert.ok(
        capturedPrompt.includes(`Client Business: ${testCompanyName}`),
        "Prompt must include client business name in merge fields",
      );
      assert.ok(
        capturedPrompt.includes(`Invoice Rescue — acting on behalf of ${testCompanyName}`),
        "Prompt must include client business name in mandatory sign-off block",
      );
      assert.ok(
        !capturedPrompt.includes("[Client Business Name]"),
        "Prompt must NEVER contain the fallback placeholder [Client Business Name]",
      );

      // Verify draft in database
      const draft = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 1001").first<any>();
      assert.ok(draft);
      assert.strictEqual(draft.status, "draft");
      assert.strictEqual(draft.step, 1);
      assert.ok(draft.body.includes(`acting on behalf of ${testCompanyName}`));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // Requirement 2: 7-Day Spacing Enforcement (Late Ingestion Protection)
  // =========================================================================
  test("R2.2: 7-day cadence spacing is strictly enforced for late-imported invoices", async () => {
    const { env, db } = createTestEnv();
    const company = "Starlight Media Ltd";
    // Invoice is imported 20 days overdue
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (102, '${company}', 'billing@starlight.test');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (1002, 102, 'Delayed Debtor Corp', 'INV-STAR-20', 500000, date('now', '-20 days'), 'overdue');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Automated test chase draft." }] }, finishReason: "STOP" }],
        }),
      );

    try {
      // Day 20: First detection run triggers Stage 1 (no prior chases exist)
      const resDay20 = await runOverdueDetection(env);
      assert.strictEqual(resDay20.draftsCreated, 1);

      const stage1Draft = await db.prepare("SELECT id, step, status FROM chase_log WHERE invoice_id = 1002").first<any>();
      assert.strictEqual(stage1Draft.step, 1);
      assert.strictEqual(stage1Draft.status, "draft");

      // Simulate operator reviews and sends Stage 1 today
      await db.prepare(
        "UPDATE chase_log SET status = 'sent', sent_at = datetime('now'), reviewed_at = datetime('now') WHERE id = ?1",
      )
        .bind(stage1Draft.id)
        .run();

      // Next Day (Day 21: 21 days overdue, but ONLY 1 day since Stage 1 was sent)
      // Standard static cadence checks (days_overdue >= 8) would prematurely trigger Stage 2.
      // 7-day spacing MUST defer and produce 0 drafts.
      const dateDay21 = new Date(Date.now() + 1 * 86400000);
      const resDay21 = await runOverdueDetection(env, dateDay21);
      assert.strictEqual(resDay21.draftsCreated, 0, "Stage 2 must not trigger 1 day after Stage 1");

      // Day 26: 26 days overdue, but ONLY 6 days since Stage 1 was sent (< 7)
      const dateDay26 = new Date(Date.now() + 6 * 86400000);
      const resDay26 = await runOverdueDetection(env, dateDay26);
      assert.strictEqual(resDay26.draftsCreated, 0, "Stage 2 must not trigger 6 days after Stage 1");

      // Day 27: Exactly 7 days since Stage 1 was sent (daysSinceChase >= 7)
      // Stage 2 Follow-up should now trigger cleanly!
      const dateDay27 = new Date(Date.now() + 7 * 86400000);
      const resDay27 = await runOverdueDetection(env, dateDay27);
      assert.strictEqual(resDay27.draftsCreated, 1, "Stage 2 must trigger exactly 7 days after Stage 1");

      const allChases = await db
        .prepare("SELECT step, status FROM chase_log WHERE invoice_id = 1002 ORDER BY step ASC")
        .all<any>();
      assert.strictEqual(allChases.results.length, 2);
      assert.strictEqual(allChases.results[0].step, 1);
      assert.strictEqual(allChases.results[0].status, "sent");
      assert.strictEqual(allChases.results[1].step, 2);
      assert.strictEqual(allChases.results[1].status, "draft");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // Requirement 3: Pending Draft Gating (Prevent Duplicate Drafts)
  // =========================================================================
  test("R2.3: Pending draft gating prevents generating duplicate drafts while unreviewed", async () => {
    const { env, db } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (103, 'Gating Co', 'gating@co.test');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (1003, 103, 'Pending Debtor', 'INV-GATE-1', 150000, date('now', '-5 days'), 'overdue');
    `);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Draft for review." }] }, finishReason: "STOP" }],
        }),
      );

    try {
      // First run: Creates Stage 1 draft
      const res1 = await runOverdueDetection(env);
      assert.strictEqual(res1.draftsCreated, 1);
      assert.strictEqual(res1.skippedDrafts, 0);

      // Verify 1 draft row exists
      const draftsAfterRun1 = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 1003").all();
      assert.strictEqual(draftsAfterRun1.results.length, 1);

      // Immediate re-run while draft is pending review: Must skip invoice and create 0 drafts
      const res2 = await runOverdueDetection(env);
      assert.strictEqual(res2.draftsCreated, 0);
      assert.strictEqual(res2.skippedDrafts, 1);

      // Simulate 5 days later with draft still pending review: Still must skip!
      const laterDate = new Date(Date.now() + 5 * 86400000);
      const res3 = await runOverdueDetection(env, laterDate);
      assert.strictEqual(res3.draftsCreated, 0);
      assert.strictEqual(res3.skippedDrafts, 1);

      // Verify total drafts in database is still exactly 1
      const draftsAfterRun3 = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 1003").all();
      assert.strictEqual(draftsAfterRun3.results.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // Requirement 4: Terminal Transition to Escalated after Stage 4
  // =========================================================================
  test("R2.4: Terminal state transition to escalated occurs 7+ days after Stage 4 final notice", async () => {
    const { env, db, notify } = createTestEnv();
    const company = "Vanguard Engineering";
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (104, '${company}', 'contact@vanguard.test');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (1004, 104, 'Unresponsive Debtor Ltd', 'INV-TERM-1004', 1200000, date('now', '-35 days'), 'overdue');

      -- Record prior 4 stages as sent, with Stage 4 sent 8 days ago
      INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
      VALUES (1004, 1, 'sent', date('now', '-29 days'), 'Stage 1'),
             (1004, 2, 'sent', date('now', '-22 days'), 'Stage 2'),
             (1004, 3, 'sent', date('now', '-15 days'), 'Stage 3'),
             (1004, 4, 'sent', date('now', '-8 days'), 'Stage 4 final notice');
    `);

    // Run overdue detection
    const result = await runOverdueDetection(env);

    // Verify terminal transition occurred
    assert.strictEqual(result.invoicesEscalated, 1);
    assert.strictEqual(result.draftsCreated, 0);

    // Verify invoice status in database transitioned to 'escalated'
    const invoice = await db.prepare("SELECT status FROM invoices WHERE id = 1004").first<any>();
    assert.strictEqual(invoice.status, "escalated");

    // Verify operator received notification via env.NOTIFY
    const escalationAlert = notify.sent.find((m) => m.subject.includes("escalated (Stage 4 exhausted)"));
    assert.ok(escalationAlert, "Operator alert must be sent via env.NOTIFY");
    assert.strictEqual(escalationAlert.to, env.NOTIFY_TO);
    assert.ok(escalationAlert.text?.includes("INV-TERM-1004"));
    assert.ok(escalationAlert.text?.includes("Hand back to client recommended"));

    // Verify subsequent cron runs ignore this invoice because status is 'escalated'
    notify.clear();
    const nextRun = await runOverdueDetection(env);
    assert.strictEqual(nextRun.invoicesEscalated, 0);
    assert.strictEqual(nextRun.draftsCreated, 0);
    assert.strictEqual(notify.sent.length, 0);
  });

  test("R2.5: Stage 4 does NOT transition to escalated before 7 days have elapsed", async () => {
    const { env, db, notify } = createTestEnv();
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (105, 'Beta Corp', 'beta@corp.test');
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
      VALUES (1005, 105, 'Debtor 1005', 'INV-WAIT-4', 750000, date('now', '-25 days'), 'overdue');

      -- Stage 4 sent only 3 days ago (< 7 days)
      INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
      VALUES (1005, 4, 'sent', date('now', '-3 days'), 'Stage 4 final notice');
    `);

    const result = await runOverdueDetection(env);
    assert.strictEqual(result.invoicesEscalated, 0);
    assert.strictEqual(result.draftsCreated, 0);

    // Invoice remains overdue
    const invoice = await db.prepare("SELECT status FROM invoices WHERE id = 1005").first<any>();
    assert.strictEqual(invoice.status, "overdue");
  });

  // =========================================================================
  // Requirement 5: Fallback Template Draft Generation when Gemini Fails
  // =========================================================================
  test("R2.6: Fallback template draft is safely generated when Gemini API is unavailable", async () => {
    const { env, db } = createTestEnv();
    const company = "Resilient Systems Ltd";
    await db.rawSqlite.exec(`
      INSERT INTO clients (id, company_name, contact_email) VALUES (106, '${company}', 'it@resilient.test');
      -- 16 days overdue -> Stage 3 (firm notice with statutory interest + fee)
      INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, currency, due_date, status)
      VALUES (1006, 106, 'Slow Payer PLC', 'INV-FALLBACK-1', 500000, 'GBP', date('now', '-16 days'), 'overdue');

      -- Prior stages sent 8+ days ago
      INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
      VALUES (1006, 1, 'sent', date('now', '-15 days'), 'Stage 1'),
             (1006, 2, 'sent', date('now', '-8 days'), 'Stage 2');
    `);

    // Mock fetch to simulate Gemini API error (503 Service Unavailable)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("API Temporarily Unavailable", { status: 503 });

    try {
      const result = await runOverdueDetection(env);
      assert.strictEqual(result.draftsCreated, 1);
      assert.strictEqual(result.errors.length, 1);

      // Verify draft was still saved into chase_log using fallback template
      const draft = await db.prepare("SELECT * FROM chase_log WHERE invoice_id = 1006 AND step = 3").first<any>();
      assert.ok(draft);
      assert.strictEqual(draft.status, "draft");
      assert.strictEqual(draft.step, 3);

      // Verify statutory citations and locked sender sign-off in fallback text
      assert.ok(draft.body.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
      assert.ok(draft.body.includes("statutory interest of GBP"));
      assert.ok(draft.body.includes("statutory compensation of GBP 70.00"));
      assert.ok(draft.body.includes(`Invoice Rescue — acting on behalf of ${company}`));
      assert.ok(draft.body.includes("hello@invoicerescue.co.uk"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // Requirement 6: Utility Functions (parseDate & diffDays)
  // =========================================================================
  test("R2.7: parseDate and diffDays correctly handle SQLite timestamps and day differences", () => {
    const d1 = parseDate("2026-09-10 14:30:00");
    const d2 = parseDate("2026-09-17 14:30:00");
    assert.strictEqual(diffDays(d2, d1), 7);

    const isoDate = parseDate("2026-09-10T12:00:00Z");
    const isoDateLater = parseDate("2026-09-20T12:00:00Z");
    assert.strictEqual(diffDays(isoDateLater, isoDate), 10);

    const simpleDate = parseDate("2026-09-01");
    const simpleDateLater = parseDate("2026-09-02");
    assert.strictEqual(diffDays(simpleDateLater, simpleDate), 1);
  });
});
