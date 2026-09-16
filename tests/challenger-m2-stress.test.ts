import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv } from "./e2e/harness";
import { statutoryInterestPence, fixedCompensationPence } from "../backend/src/lib/statutory-interest";
import { buildChasePrompt, draftChaseMessage, type ChasePromptInput } from "../backend/src/lib/gemini";
import {
  runOverdueDetection,
  generateFallbackDraft,
  parseDate,
  diffDays,
  SENDER_NAME,
  type OverdueInvoiceRow,
} from "../backend/src/lib/chase-runner";
import worker from "../backend/src/index";

describe("Empirical Challenger 2 — Milestone M2 Stress Suite", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // SUITE 1: Statutory Interest Precision Across Leap Years, Multi-Year Debts,
  //          Fractional Pennies, Base Rate Variations & Zero Drift
  // =========================================================================
  describe("1. Statutory Interest Precision & Accumulation Drift", () => {
    test("1.1 Leap Year (366 days): verifies daily accrual and exact 366-day calculation without drift", () => {
      // UK Late Payment Act uses 365 days as the standard divisor: (Principal * (BaseRate + 8) / 100 / 365) * Days
      const boeRate = 3.75; // 3.75% + 8.00% = 11.75%
      const amountPence = 100_000; // £1,000.00

      // Day 365: (100,000 * 11.75 / 100 / 365) * 365 = exactly 11,750 pence (£117.50)
      const day365 = statutoryInterestPence(amountPence, 365, boeRate);
      assert.strictEqual(day365, 11750);

      // Day 366: (100,000 * 11.75 / 100 / 365) * 366 = 11782.19178... pence -> Math.round is 11782 pence (£117.82)
      const day366 = statutoryInterestPence(amountPence, 366, boeRate);
      assert.strictEqual(day366, 11782);

      // Delta for the leap day: 11782 - 11750 = 32 pence
      // Daily unrounded rate = 11750 / 365 = 32.19178... pence
      assert.strictEqual(day366 - day365, 32);

      // Test a larger debt: £25,000.00 (2,500,000 pence) across leap year
      // At BoE 5.0% (total 13.0%):
      // Day 365: 2,500,000 * 0.13 = 325,000 pence (£3,250.00)
      // Day 366: (325,000 / 365) * 366 = 325890.41... -> Math.round is 325890 pence (£3,258.90)
      const largeDay365 = statutoryInterestPence(2_500_000, 365, 5.0);
      const largeDay366 = statutoryInterestPence(2_500_000, 366, 5.0);
      assert.strictEqual(largeDay365, 325000);
      assert.strictEqual(largeDay366, 325890);
      assert.strictEqual(largeDay366 - largeDay365, 890); // 325000 / 365 = 890.4109... pence
    });

    test("1.2 Multi-Year Debts (730 days, 1095 days, 1460 days): zero accumulation drift over 2 to 4 years", () => {
      // 730 days is exactly 2 * 365 days.
      // For any debt where annual interest is an exact integer number of pence,
      // 730 days MUST be exactly 2 * 365-day interest!
      const testCases = [
        { amountPence: 100_000, boeRate: 5.0, annualPence: 13000 }, // 13.0% on £1,000 = £130 = 13000p
        { amountPence: 200_000, boeRate: 4.0, annualPence: 24000 }, // 12.0% on £2,000 = £240 = 24000p
        { amountPence: 500_000, boeRate: 2.0, annualPence: 50000 }, // 10.0% on £5,000 = £500 = 50000p
        { amountPence: 1_000_000, boeRate: 0.0, annualPence: 80000 }, // 8.0% on £10,000 = £800 = 80000p
      ];

      for (const tc of testCases) {
        const yr1 = statutoryInterestPence(tc.amountPence, 365, tc.boeRate);
        const yr2 = statutoryInterestPence(tc.amountPence, 730, tc.boeRate);
        const yr3 = statutoryInterestPence(tc.amountPence, 1095, tc.boeRate);
        const yr4 = statutoryInterestPence(tc.amountPence, 1460, tc.boeRate);

        assert.strictEqual(yr1, tc.annualPence, `Year 1 interest for ${tc.amountPence}p`);
        assert.strictEqual(yr2, tc.annualPence * 2, `Year 2 (730d) interest must have ZERO drift`);
        assert.strictEqual(yr3, tc.annualPence * 3, `Year 3 (1095d) interest must have ZERO drift`);
        assert.strictEqual(yr4, tc.annualPence * 4, `Year 4 (1460d) interest must have ZERO drift`);
      }
    });

    test("1.3 Monotonicity and Accumulation Drift over 1,000 Consecutive Days", () => {
      // If a system accumulates rounded pennies daily, rounding errors compound heavily.
      // statutoryInterestPence must evaluate the closed-form equation directly and be strictly monotonic.
      const amountPence = 543_210; // £5,432.10
      const boeRate = 3.75; // 11.75%
      const exactDailyRate = (amountPence * 11.75) / 100 / 365; // ~174.869 pence/day

      let previousInterest = -1;
      for (let day = 0; day <= 1000; day++) {
        const interest = statutoryInterestPence(amountPence, day, boeRate);

        // Day 0 must be 0
        if (day === 0) {
          assert.strictEqual(interest, 0);
        } else {
          // Monotonicity: interest must never decrease as days increase
          assert.ok(
            interest >= previousInterest,
            `Interest at day ${day} (${interest}) must be >= day ${day - 1} (${previousInterest})`,
          );

          // Daily step must equal either floor(exactDailyRate) or ceil(exactDailyRate)
          const step = interest - previousInterest;
          assert.ok(
            step === Math.floor(exactDailyRate) || step === Math.ceil(exactDailyRate),
            `Step at day ${day} (${step}) must be either ${Math.floor(exactDailyRate)} or ${Math.ceil(exactDailyRate)}`,
          );

          // Drift check: difference from exact closed-form unrounded value must be <= 0.5 pence
          const exactUnrounded = exactDailyRate * day;
          assert.ok(
            Math.abs(interest - exactUnrounded) <= 0.5,
            `Drift at day ${day} (${Math.abs(interest - exactUnrounded)}) exceeds 0.5 pence`,
          );
        }
        previousInterest = interest;
      }
    });

    test("1.4 Base Rate Changes (0.1% to 15.0%) across various debt sizes", () => {
      const rates = [
        { boe: 0.1, total: 8.1 },
        { boe: 3.75, total: 11.75 },
        { boe: 4.25, total: 12.25 },
        { boe: 5.0, total: 13.0 },
        { boe: 5.25, total: 13.25 },
        { boe: 8.0, total: 16.0 },
        { boe: 15.0, total: 23.0 },
      ];

      const amountPence = 250_000; // £2,500.00
      const days = 60;

      for (const r of rates) {
        const expected = Math.round(((amountPence * r.total) / 100 / 365) * days);
        const actual = statutoryInterestPence(amountPence, days, r.boe);
        assert.strictEqual(actual, expected, `Interest mismatch for BoE rate ${r.boe}%`);
      }
    });

    test("1.5 Microscopic and Massive Principal Debts (Fractional Pennies & Large Numbers)", () => {
      // 1 penny debt for 1 day: (1 * 11.75 / 100 / 365) * 1 = 0.00032... -> rounds to 0
      assert.strictEqual(statutoryInterestPence(1, 1, 3.75), 0);
      // 1 penny debt for 365 days: 1 * 0.1175 = 0.1175 -> rounds to 0
      assert.strictEqual(statutoryInterestPence(1, 365, 3.75), 0);
      // 100 pence (£1) for 365 days: 100 * 0.1175 = 11.75 -> rounds to 12 pence
      assert.strictEqual(statutoryInterestPence(100, 365, 3.75), 12);

      // Massive debt: £10,000,000.00 (1,000,000,000 pence) for 730 days at 5% BoE (13%)
      // 1,000,000,000 * 0.13 * 2 = 260,000,000 pence (£2,600,000.00)
      const massiveInterest = statutoryInterestPence(1_000_000_000, 730, 5.0);
      assert.strictEqual(massiveInterest, 260_000_000);
    });
  });

  // =========================================================================
  // SUITE 2: Boundary Compensation Amounts Precision (£999.99 vs £1,000.00 & £9,999.99 vs £10,000.00)
  // =========================================================================
  describe("2. Statutory Compensation Boundary Tiers", () => {
    test("2.1 Exact threshold transitions: £999.99 (4000p) vs £1,000.00 (7000p)", () => {
      // Under £1,000 (< 100,000 pence) -> £40 (4,000 pence)
      assert.strictEqual(fixedCompensationPence(99_998), 4000, "£999.98 must yield £40");
      assert.strictEqual(fixedCompensationPence(99_999), 4000, "£999.99 (99,999p) must yield £40 (4000p)");

      // Exactly £1,000.00 (100,000 pence) -> £70 (7,000 pence)
      assert.strictEqual(fixedCompensationPence(100_000), 7000, "£1,000.00 (100,000p) must yield £70 (7000p)");
      assert.strictEqual(fixedCompensationPence(100_001), 7000, "£1,000.01 (100,001p) must yield £70 (7000p)");
    });

    test("2.2 Exact threshold transitions: £9,999.99 (7000p) vs £10,000.00 (10000p)", () => {
      // £1,000 to £9,999.99 (100,000 to 999,999 pence) -> £70 (7,000 pence)
      assert.strictEqual(fixedCompensationPence(999_998), 7000, "£9,999.98 must yield £70");
      assert.strictEqual(fixedCompensationPence(999_999), 7000, "£9,999.99 (999,999p) must yield £70 (7000p)");

      // Exactly £10,000.00 (1,000,000 pence) -> £100 (10,000 pence)
      assert.strictEqual(fixedCompensationPence(1_000_000), 10000, "£10,000.00 (1,000,000p) must yield £100 (10000p)");
      assert.strictEqual(fixedCompensationPence(1_000_001), 10000, "£10,000.01 (1,000,001p) must yield £100 (10000p)");
    });

    test("2.3 Boundary values: Zero, single penny, sub-penny floating numbers and extreme debts", () => {
      assert.strictEqual(fixedCompensationPence(0), 4000);
      assert.strictEqual(fixedCompensationPence(1), 4000);
      assert.strictEqual(fixedCompensationPence(99_999.9), 4000);
      assert.strictEqual(fixedCompensationPence(999_999.9), 7000);
      assert.strictEqual(fixedCompensationPence(50_000_000), 10000); // £500,000
    });
  });

  // =========================================================================
  // SUITE 3: Prompt Construction & Locked Sender Model Invariants
  // =========================================================================
  describe("3. Locked Sender Model & Prompt Construction Invariants", () => {
    const clientCompanies = [
      "Apex Design Ltd",
      "Vanguard Logistics PLC",
      "O'Connor & Sons LLP",
      "Tech-Solutions (UK) Ltd",
      "Global Media, Partners & Co.",
    ];

    test("3.1 Prompt construction across all 4 stages enforces locked sender and genuine client business name", () => {
      for (const company of clientCompanies) {
        for (let step = 1; step <= 4; step++) {
          const promptInput: ChasePromptInput = {
            clientVoiceNotes: "Direct, professional.",
            debtorName: "Acme Holdings",
            invoiceNumber: `INV-${step}-001`,
            amountPence: 250_000,
            currency: "GBP",
            dueDate: "2026-08-01",
            daysOverdue: step * 7 + 1,
            step,
            stepLabel: `stage_${step}`,
            statutoryInterestPence: 2415,
            fixedCompensationPence: 7000,
            clientBusinessName: company,
          };

          const prompt = buildChasePrompt(promptInput);

          // Rule 1: Zero fallback placeholder [Client Business Name]
          assert.ok(
            !prompt.includes("[Client Business Name]"),
            `Step ${step} for ${company} MUST NOT contain placeholder [Client Business Name]`,
          );

          // Rule 2: Client business name appears in merge fields and sign-off
          assert.ok(
            prompt.includes(`Client Business: ${company}`),
            `Step ${step} must specify Client Business: ${company}`,
          );
          assert.ok(
            prompt.includes(`Invoice Rescue — acting on behalf of ${company}`),
            `Step ${step} sign-off must specify Invoice Rescue — acting on behalf of ${company}`,
          );

          // Rule 3: Locked sender is strictly hello@invoicerescue.co.uk and signed by Tibor Rames
          assert.ok(prompt.includes("FROM: hello@invoicerescue.co.uk"));
          assert.ok(prompt.includes("Tibor Rames"));
          assert.ok(prompt.includes("hello@invoicerescue.co.uk"));

          // Rule 4: Stage specific requirements
          if (step === 1) {
            assert.ok(prompt.includes("Do not mention statutory interest yet — keep it light"));
            assert.ok(!prompt.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
          } else if (step === 2) {
            assert.ok(prompt.includes("Following up, asking when to expect payment"));
          } else if (step === 3) {
            assert.ok(prompt.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
            assert.ok(prompt.includes("Mention statutory interest of GBP 24.15 and fixed compensation of GBP 70.00"));
          } else if (step === 4) {
            assert.ok(prompt.includes("give 7-day notice before returning the matter to the client"));
            assert.ok(prompt.includes("Mention statutory interest of GBP 24.15 and fixed compensation of GBP 70.00"));
          }
        }
      }
    });

    test("3.2 Fallback draft templates across all 4 stages strictly maintain locked sender and genuine client name", () => {
      for (const company of clientCompanies) {
        for (let step = 1; step <= 4; step++) {
          const inv: OverdueInvoiceRow = {
            id: step,
            client_id: 10,
            debtor_name: "John Smith",
            debtor_email: "john@acme.test",
            invoice_number: `INV-FB-${step}`,
            amount_pence: 500_000,
            currency: "GBP",
            due_date: "2026-08-15",
            days_overdue: step * 7,
            company_name: company,
            voice_notes: null,
          };

          const fallback = generateFallbackDraft(inv, step, 3500, 7000);

          // Rule 1: Zero fallback placeholder
          assert.ok(
            !fallback.includes("[Client Business Name]"),
            `Fallback step ${step} for ${company} MUST NOT contain placeholder [Client Business Name]`,
          );

          // Rule 2: Signed by Tibor Rames on behalf of client
          assert.ok(
            fallback.includes("Tibor Rames"),
            `Fallback step ${step} must be signed by Tibor Rames`,
          );
          assert.ok(
            fallback.includes(`Invoice Rescue — acting on behalf of ${company}`),
            `Fallback step ${step} must specify acting on behalf of ${company}`,
          );
          assert.ok(
            fallback.includes("hello@invoicerescue.co.uk"),
            `Fallback step ${step} must specify hello@invoicerescue.co.uk`,
          );

          // Rule 3: Stage-appropriate content
          if (step === 3) {
            assert.ok(fallback.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
            assert.ok(fallback.includes("statutory interest of GBP 35.00"));
            assert.ok(fallback.includes("statutory compensation of GBP 70.00"));
          }
          if (step === 4) {
            assert.ok(fallback.includes("formal 7-day notice"));
            assert.ok(fallback.includes(`return this matter to ${company} for legal recovery`));
            assert.ok(fallback.includes("statutory interest of GBP 35.00"));
            assert.ok(fallback.includes("compensation of GBP 70.00"));
          }
        }
      }
    });

    test("3.3 runOverdueDetection E2E: intercepts Gemini API calls and confirms locked sender and client name in real D1 flow", async () => {
      const { env, db } = createTestEnv();
      const testCompany = "Helix Interactive Media Ltd";

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email, voice_notes)
        VALUES (201, '${testCompany}', 'admin@helix.test', 'Warm but assertive.');

        -- Step 1 invoice (3 days overdue)
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
        VALUES (2001, 201, 'Debtor Alpha', 'alpha@test.com', 'INV-H-001', 150000, 'GBP', date('now', '-3 days'), 'overdue');

        -- Step 3 invoice (16 days overdue, prior stages sent)
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status)
        VALUES (2002, 201, 'Debtor Gamma', 'gamma@test.com', 'INV-H-003', 850000, 'GBP', date('now', '-16 days'), 'overdue');

        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (2002, 1, 'sent', date('now', '-15 days'), 'Stage 1 sent'),
               (2002, 2, 'sent', date('now', '-8 days'), 'Stage 2 sent');
      `);

      const capturedPrompts: string[] = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("generativelanguage.googleapis.com") && init?.body) {
          const bodyObj = JSON.parse(String(init.body));
          const text = bodyObj.contents?.[0]?.parts?.[0]?.text || "";
          capturedPrompts.push(text);
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: `Automated chase draft.\n\nTibor Rames\nInvoice Rescue — acting on behalf of ${testCompany}\nhello@invoicerescue.co.uk`,
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

      const result = await runOverdueDetection(env);
      assert.strictEqual(result.draftsCreated, 2);
      assert.strictEqual(capturedPrompts.length, 2);

      for (const prompt of capturedPrompts) {
        assert.ok(
          !prompt.includes("[Client Business Name]"),
          "Intercepted Gemini prompt must NEVER contain [Client Business Name]",
        );
        assert.ok(
          prompt.includes(`Client Business: ${testCompany}`),
          "Intercepted prompt must specify genuine company name",
        );
        assert.ok(
          prompt.includes(`Invoice Rescue — acting on behalf of ${testCompany}`),
          "Intercepted prompt sign-off must specify genuine company name",
        );
        assert.ok(
          prompt.includes("FROM: hello@invoicerescue.co.uk"),
          "Intercepted prompt must specify FROM: hello@invoicerescue.co.uk",
        );
      }

      // Check the draft rows created in chase_log
      const drafts = await db.prepare("SELECT * FROM chase_log WHERE status = 'draft' ORDER BY step ASC").all<any>();
      assert.strictEqual(drafts.results.length, 2);
      for (const d of drafts.results) {
        assert.ok(d.body.includes(`acting on behalf of ${testCompany}`));
        assert.ok(d.body.includes("hello@invoicerescue.co.uk"));
        assert.ok(!d.body.includes("[Client Business Name]"));
      }
    });

    test("3.4 Operator approval and send uses strictly locked sender hello@invoicerescue.co.uk", async () => {
      const { env, db, send } = createTestEnv();
      const testCompany = "Zenith Consulting Group";

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email)
        VALUES (301, '${testCompany}', 'contact@zenith.test');

        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (3001, 301, 'Target Debtor Ltd', 'debtor@target.test', 'INV-ZEN-1', 450000, date('now', '-5 days'), 'overdue');

        INSERT INTO chase_log (id, invoice_id, step, channel, status, body)
        VALUES (30001, 3001, 1, 'email', 'draft', 'Reminder message text.\n\nTibor Rames\nInvoice Rescue — acting on behalf of Zenith Consulting Group\nhello@invoicerescue.co.uk');
      `);

      // Operator approves the draft via POST /api/chase/30001/approve
      const req = new Request("http://localhost/api/chase/30001/approve", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa("admin:admin-test-secret-12345")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 303, "HTML form submission must redirect with HTTP 303 See Other");
      assert.strictEqual(res.headers.get("Location"), "/admin");

      // Verify email was dispatched via env.SEND
      assert.strictEqual(send.sent.length, 1);
      const sentEmail = send.sent[0];
      assert.strictEqual(sentEmail.to, "debtor@target.test");
      assert.strictEqual(sentEmail.from.name, "Invoice Rescue");
      assert.strictEqual(sentEmail.from.email, "hello@invoicerescue.co.uk");
      assert.ok(sentEmail.text?.includes("Tibor Rames"));
      assert.ok(sentEmail.text?.includes(`Invoice Rescue — acting on behalf of ${testCompany}`));
      assert.ok(sentEmail.text?.includes("hello@invoicerescue.co.uk"));
      assert.ok(!sentEmail.text?.includes("[Client Business Name]"));
    });
  });

  // =========================================================================
  // SUITE 4: Leap Day Date Arithmetic & Multi-Tenant Batch Invariant Stress
  // =========================================================================
  describe("4. Leap Day Date Arithmetic & Multi-Tenant Batch Invariant Stress", () => {
    test("4.1 Leap day parsing and day difference across leap boundaries", () => {
      // Leap year 2024: 2024-02-28 to 2024-03-01 is 2 days (includes Feb 29)
      const feb28 = parseDate("2024-02-28");
      const feb29 = parseDate("2024-02-29");
      const mar01 = parseDate("2024-03-01");

      assert.strictEqual(diffDays(feb29, feb28), 1);
      assert.strictEqual(diffDays(mar01, feb29), 1);
      assert.strictEqual(diffDays(mar01, feb28), 2);

      // Leap year 2028: 2028-01-01 to 2028-12-31 is 365 days, to 2029-01-01 is 366 days
      const leapStart = parseDate("2028-01-01");
      const leapEnd = parseDate("2028-12-31");
      const nextYear = parseDate("2029-01-01");

      assert.strictEqual(diffDays(leapEnd, leapStart), 365);
      assert.strictEqual(diffDays(nextYear, leapStart), 366);
    });

    test("4.2 Batch multi-tenant execution: 30 invoices across 3 clients with mixed stages and zero cross-talk", async () => {
      const { env, db, notify } = createTestEnv();

      // Create 3 distinct clients
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES
          (401, 'Client Alpha Ltd', 'alpha@client.test'),
          (402, 'Client Beta LLP', 'beta@client.test'),
          (403, 'Client Gamma Co', 'gamma@client.test');
      `);

      // Insert 10 invoices per client = 30 total invoices overdue
      for (let c = 1; c <= 3; c++) {
        const clientId = 400 + c;
        for (let i = 1; i <= 10; i++) {
          const invId = clientId * 100 + i;
          const daysOverdue = 2 + i; // 3 to 12 days overdue -> all due for Stage 1
          const amountPence = 50_000 * i; // £500 to £5,000
          await db.rawSqlite.exec(`
            INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
            VALUES (${invId}, ${clientId}, 'Debtor ${invId}', 'INV-${clientId}-${i}', ${amountPence}, date('now', '-${daysOverdue} days'), 'overdue');
          `);
        }
      }

      // Mock Gemini API
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Automated batch chase draft." }] }, finishReason: "STOP" }],
          }),
        );

      const result = await runOverdueDetection(env);
      assert.strictEqual(result.draftsCreated, 30, "All 30 overdue invoices must have drafts created");
      assert.strictEqual(result.errors.length, 0);

      // Verify draft rows: each invoice must have correct client company name in body
      const drafts = await db.prepare("SELECT c.company_name, cl.body, cl.step, cl.status FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id JOIN clients c ON c.id = i.client_id").all<any>();
      assert.strictEqual(drafts.results.length, 30);

      for (const d of drafts.results) {
        assert.strictEqual(d.step, 1);
        assert.strictEqual(d.status, "draft");
        assert.ok(d.company_name);
        assert.ok(!d.body.includes("[Client Business Name]"));
      }

      // Operator notification must have been sent with exactly 1 consolidated email mentioning 30 drafts
      const operatorAlert = notify.sent.find((m) => m.subject.includes("chase draft(s) ready for review"));
      assert.ok(operatorAlert);
      assert.ok(operatorAlert.subject.includes("30 chase draft(s)"));
      assert.ok(operatorAlert.text?.includes("30 chase message(s) are waiting"));
    });

    test("4.3 Adversarial characters in company and debtor names survive prompt and fallback construction", () => {
      const adversarialInputs = [
        {
          company: 'Acme & "Sons" <Legal> Ltd',
          debtor: "O'Reilly & Co. (UK)",
          notes: 'Special instruction: "Ensure bold tone & mention Act 1998".',
        },
        {
          company: "Café René & Frères S.A.R.L. / 100% Cotton",
          debtor: "Müller GmbH — München",
          notes: "Strict: No compromises.",
        },
        {
          company: "DROP TABLE clients; -- injection Ltd",
          debtor: "SELECT * FROM users; -- debtor",
          notes: null,
        },
      ];

      for (const item of adversarialInputs) {
        const promptInput: ChasePromptInput = {
          clientVoiceNotes: item.notes,
          debtorName: item.debtor,
          invoiceNumber: "INV-ADV-01",
          amountPence: 150_000,
          currency: "GBP",
          dueDate: "2026-08-01",
          daysOverdue: 10,
          step: 2,
          stepLabel: "stage_2",
          statutoryInterestPence: 1200,
          fixedCompensationPence: 7000,
          clientBusinessName: item.company,
        };

        const prompt = buildChasePrompt(promptInput);
        assert.ok(!prompt.includes("[Client Business Name]"));
        assert.ok(prompt.includes(`Client Business: ${item.company}`));
        assert.ok(prompt.includes(`Debtor Contact: ${item.debtor}`));
        assert.ok(prompt.includes(`Invoice Rescue — acting on behalf of ${item.company}`));

        const inv: OverdueInvoiceRow = {
          id: 99,
          client_id: 1,
          debtor_name: item.debtor,
          debtor_email: "debtor@test.test",
          invoice_number: "INV-ADV-01",
          amount_pence: 150_000,
          currency: "GBP",
          due_date: "2026-08-01",
          days_overdue: 10,
          company_name: item.company,
          voice_notes: item.notes,
        };

        const fallback = generateFallbackDraft(inv, 2, 1200, 7000);
        assert.ok(!fallback.includes("[Client Business Name]"));
        assert.ok(fallback.includes(`Hi ${item.debtor}`));
        assert.ok(fallback.includes(`Invoice Rescue — acting on behalf of ${item.company}`));
      }
    });
  });
});
