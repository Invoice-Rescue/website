import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fixedCompensationPence,
  statutoryInterestPence,
} from "../backend/src/lib/statutory-interest";
import {
  CADENCE_DAYS,
  STEP_LABELS,
  diffDays,
  nextStepDue,
  advanceEscalationStage,
} from "../backend/src/lib/escalation";
import {
  runOverdueDetection,
  parseDate,
  generateFallbackDraft,
} from "../backend/src/lib/chase-runner";
import {
  encryptToken,
  decryptToken,
  generateOAuthState,
  verifyOAuthState,
  buildAuthorizationUrl,
  toBase64Url,
  fromBase64Url,
} from "../backend/src/lib/integrations/oauth-manager";
import {
  verifyQuickBooksWebhook,
  verifyXeroWebhook,
  parseQuickBooksInvoiceUpdate,
  parseXeroInvoiceUpdate,
} from "../backend/src/lib/integrations/webhooks";
import {
  verifyWebhookSignature,
} from "../backend/src/lib/stripe";
import {
  sendOperatorNotification,
  sendDebtorCommunication,
  isValidEmail,
  formatDebtorSignoff,
  SENDER_NAME,
  LOCKED_SENDER_EMAIL,
  OPERATOR_INBOX_EMAIL,
} from "../backend/src/lib/email";
import { SyncService, type NormalizedInvoice } from "../backend/src/lib/integrations/sync-service";
import { createTestDb, createTestEnv, signHmacSha256 } from "./e2e/harness";
import type { InvoiceEscalationState, ChaseHistoryRow } from "../backend/src/types/core";

describe("Tier 5 White-Box Adversarial Hardening — Backend Core Engines", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // DIMENSION 1: Statutory Math & Date Engine Probing
  // =========================================================================
  describe("1. Statutory Math & Date Engine Probing", () => {
    test("1.1 Extreme Calendar Boundaries: Leap Years, Leap Centuries, & Date Arithmetic", () => {
      // 2024 is a leap year (366 days)
      const d1 = new Date("2024-03-01T00:00:00Z");
      const d2 = new Date("2024-02-28T00:00:00Z");
      assert.strictEqual(diffDays(d1, d2), 2, "2024 leap year Feb 28 to Mar 1 must be 2 days");

      // 2025 is a non-leap year (365 days)
      const d3 = new Date("2025-03-01T00:00:00Z");
      const d4 = new Date("2025-02-28T00:00:00Z");
      assert.strictEqual(diffDays(d3, d4), 1, "2025 non-leap year Feb 28 to Mar 1 must be 1 day");

      // Year 2000 was a leap century (divisible by 400)
      const d5 = new Date("2000-03-01T00:00:00Z");
      const d6 = new Date("2000-02-28T00:00:00Z");
      assert.strictEqual(diffDays(d5, d6), 2, "Year 2000 (leap century) Feb 28 to Mar 1 must be 2 days");

      // Year 2100 is NOT a leap year (divisible by 100, but not 400)
      const d7 = new Date("2100-03-01T00:00:00Z");
      const d8 = new Date("2100-02-28T00:00:00Z");
      assert.strictEqual(diffDays(d7, d8), 1, "Year 2100 (non-leap century) Feb 28 to Mar 1 must be 1 day");

      // Multi-year debt duration: 4 full years (1,461 days with 1 leap day)
      const dStart = new Date("2020-01-01T00:00:00Z");
      const dEnd = new Date("2024-01-01T00:00:00Z");
      assert.strictEqual(diffDays(dEnd, dStart), 1461, "4 years with 2020 leap year is 1,461 days");
    });

    test("1.2 Statutory Compensation Exact Thresholds & Fractional Pence", () => {
      // Sub-£1,000 tier (< 100,000 pence): £40 (4,000 pence)
      assert.strictEqual(fixedCompensationPence(1), 4000);
      assert.strictEqual(fixedCompensationPence(99_999), 4000);
      assert.strictEqual(fixedCompensationPence(99_999.99), 4000);

      // £1,000 to £9,999.99 tier (100,000 to 999,999 pence): £70 (7,000 pence)
      assert.strictEqual(fixedCompensationPence(100_000), 7000);
      assert.strictEqual(fixedCompensationPence(500_000), 7000);
      assert.strictEqual(fixedCompensationPence(999_999), 7000);
      assert.strictEqual(fixedCompensationPence(999_999.99), 7000);

      // £10,000+ tier (>= 1,000,000 pence): £100 (10,000 pence)
      assert.strictEqual(fixedCompensationPence(1_000_000), 10000);
      assert.strictEqual(fixedCompensationPence(10_000_000), 10000);
      assert.strictEqual(fixedCompensationPence(100_000_000), 10000);
    });

    test("1.3 Interest Accrual on 0 Days, Negative Days, & Fractional Base Rates", () => {
      const boeRate = 3.75; // Annual rate = 11.75%
      const amountPence = 500_000; // £5,000

      // 0 days overdue: interest must be strictly 0
      const zeroDays = statutoryInterestPence(amountPence, 0, boeRate);
      assert.strictEqual(zeroDays, 0);

      // 1 day overdue on £5,000:
      // (500,000 * 11.75 / 100 / 365) * 1 = 160.9589... rounded to 161 pence
      const oneDay = statutoryInterestPence(amountPence, 1, boeRate);
      assert.strictEqual(oneDay, 161);

      // Fractional BoE rate: e.g. 5.125% -> 13.125% annual
      const fractionalRate = 5.125;
      const interestFrac = statutoryInterestPence(100_000, 365, fractionalRate);
      // (100,000 * 13.125 / 100 / 365) * 365 = 13,125 pence exactly
      assert.strictEqual(interestFrac, 13125);

      // Negative days: if invoked with negative overdue, returns negative (caller must guard)
      const negDays = statutoryInterestPence(amountPence, -5, boeRate);
      assert.ok(negDays < 0, "statutoryInterestPence reflects raw mathematical formula");
    });

    test("1.4 Multi-Million Pound Claims & Large Number Precision", () => {
      const boeRate = 4.0; // 12% annual
      // £10,000,000 claim = 1,000,000,000 pence
      const tenMillionPence = 1_000_000_000;
      const interest10m = statutoryInterestPence(tenMillionPence, 365, boeRate);
      assert.strictEqual(interest10m, 120_000_000, "£10M claim earns £1.2M annual interest");

      // £100,000,000 claim = 10,000,000,000 pence
      const hundredMillionPence = 10_000_000_000;
      const interest100m = statutoryInterestPence(hundredMillionPence, 30, boeRate);
      // (10,000,000,000 * 12 / 100 / 365) * 30 = 98,630,136.98... -> 98,630,137
      assert.strictEqual(interest100m, 98_630_137);

      // £1,000,000,000 claim (1 billion pounds) = 100,000,000,000 pence
      const oneBillionPence = 100_000_000_000;
      const interest1b = statutoryInterestPence(oneBillionPence, 365, boeRate);
      assert.strictEqual(interest1b, 12_000_000_000);
      assert.ok(Number.isSafeInteger(interest1b), "Calculations stay safely within Number.MAX_SAFE_INTEGER");
    });

    test("1.5 Date Parser Robustness across Formats & Delimiters", () => {
      // ISO timestamp with Z
      const d1 = parseDate("2026-09-16T12:00:00Z");
      assert.strictEqual(d1.toISOString(), "2026-09-16T12:00:00.000Z");

      // ISO timestamp with T but no trailing Z
      const d2 = parseDate("2026-09-16T12:00:00");
      assert.strictEqual(d2.toISOString(), "2026-09-16T12:00:00.000Z");

      // Space delimiter (SQLite datetime format)
      const d3 = parseDate("2026-09-16 12:00:00");
      assert.strictEqual(d3.toISOString(), "2026-09-16T12:00:00.000Z");

      // Date only
      const d4 = parseDate("2026-09-16");
      assert.strictEqual(d4.toISOString(), "2026-09-16T00:00:00.000Z");

      // Date instance pass-through
      const now = new Date();
      assert.strictEqual(parseDate(now).getTime(), now.getTime());

      // Epoch timestamp number pass-through
      const epochMs = 1758000000000;
      assert.strictEqual(parseDate(epochMs).getTime(), epochMs);
    });

    test("1.6 Zero/Negative Debt and Zero/Negative Base Rate Edge Behavior", () => {
      // 0 principal debt earns 0 interest regardless of days
      assert.strictEqual(statutoryInterestPence(0, 100, 3.75), 0);
      assert.strictEqual(statutoryInterestPence(0, 0, 3.75), 0);

      // Negative debt (e.g. credit note) produces 4000 pence compensation because -500 < 100_000
      assert.strictEqual(fixedCompensationPence(-500), 4000);

      // Zero BoE base rate: statutory margin of 8% still applies
      // (100,000 * 8 / 100 / 365) * 30 = 657.534... rounded to 658 pence
      assert.strictEqual(statutoryInterestPence(100_000, 30, 0), 658);
    });
  });

  // =========================================================================
  // DIMENSION 2: Escalation Engine & Cadence State Machine
  // =========================================================================
  describe("2. Escalation Engine & Cadence State Machine", () => {
    test("2.1 Cadence Boundary Conditions: Days 0, 1, 7, 8, 14, 15, 21, 22, 23", () => {
      // Step 1: CADENCE_DAYS[0] = 1
      assert.strictEqual(nextStepDue(0, []), null, "Day 0 (due today) should not trigger Step 1");
      assert.strictEqual(nextStepDue(1, []), 1, "Day 1 overdue should trigger Step 1");

      // Step 2: CADENCE_DAYS[1] = 8
      const hist1: ChaseHistoryRow[] = [{ step: 1 }];
      assert.strictEqual(nextStepDue(7, hist1), null, "Day 7 should not trigger Step 2 (requires 8+ days)");
      assert.strictEqual(nextStepDue(8, hist1), 2, "Day 8 should trigger Step 2");

      // Step 3: CADENCE_DAYS[2] = 15
      const hist2: ChaseHistoryRow[] = [{ step: 1 }, { step: 2 }];
      assert.strictEqual(nextStepDue(14, hist2), null, "Day 14 should not trigger Step 3 (requires 15+ days)");
      assert.strictEqual(nextStepDue(15, hist2), 3, "Day 15 should trigger Step 3");

      // Step 4: CADENCE_DAYS[3] = 22
      const hist3: ChaseHistoryRow[] = [{ step: 1 }, { step: 2 }, { step: 3 }];
      assert.strictEqual(nextStepDue(21, hist3), null, "Day 21 should not trigger Step 4 (requires 22+ days)");
      assert.strictEqual(nextStepDue(22, hist3), 4, "Day 22 should trigger Step 4");

      // Sequence Exhausted: All 4 steps logged
      const hist4: ChaseHistoryRow[] = [{ step: 1 }, { step: 2 }, { step: 3 }, { step: 4 }];
      assert.strictEqual(nextStepDue(22, hist4), null, "Sequence exhausted returns null");
      assert.strictEqual(nextStepDue(50, hist4), null, "Sequence exhausted returns null even at 50 days");
    });

    test("2.2 advanceEscalationStage State Machine Transitions", () => {
      const today = new Date("2026-09-16T00:00:00Z");
      const dueDate = new Date("2026-09-16T00:00:00Z"); // Due today: 0 days overdue

      // Day 0: Not yet overdue
      const state0: InvoiceEscalationState = { stage: "new", dueDate, lastChaseDate: null };
      const dec0 = advanceEscalationStage(state0, today);
      assert.strictEqual(dec0.stage, "new");
      assert.strictEqual(dec0.nextAction, "Not yet overdue — no action");

      // Missing due date returns safe guard
      const stateNoDate: InvoiceEscalationState = { stage: "new", dueDate: null as any, lastChaseDate: null };
      const decNoDate = advanceEscalationStage(stateNoDate, today);
      assert.strictEqual(decNoDate.stage, "new");
      assert.ok(decNoDate.nextAction.includes("No due_date"));

      // Terminal stage input (e.g. 'paid'): stage remains unchanged
      const statePaid: InvoiceEscalationState = { stage: "paid" as any, dueDate, lastChaseDate: null };
      const decPaid = advanceEscalationStage(statePaid, today);
      assert.strictEqual(decPaid.stage, "paid");
      assert.strictEqual(decPaid.nextAction, "No action — waiting");
    });

    test("2.3 Rapid Cron Triggers & Idempotent Gating (Zero Duplicate Drafts)", async () => {
      const { env, db } = createTestEnv();

      // Seed client and overdue invoice
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Acme Corp', 'acme@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (101, 1, 'Debtor Rapid', 'INV-RAPID-01', 50000, date('now', '-5 days'), 'overdue');
      `);

      // Mock Gemini to return mock message
      env.GEMINI_API_KEY = "mock_key";

      // Run 1: Should create exactly 1 draft
      const res1 = await runOverdueDetection(env);
      assert.strictEqual(res1.draftsCreated, 1);
      assert.strictEqual(res1.skippedDrafts, 0);

      // Run 2: Immediately after (pending draft in chase_log) -> skips
      const res2 = await runOverdueDetection(env);
      assert.strictEqual(res2.draftsCreated, 0);
      assert.strictEqual(res2.skippedDrafts, 1);

      // Run 3: Third rapid trigger -> skips again
      const res3 = await runOverdueDetection(env);
      assert.strictEqual(res3.draftsCreated, 0);
      assert.strictEqual(res3.skippedDrafts, 1);

      // Verify DB has strictly 1 draft in chase_log
      const drafts = await db.prepare("SELECT COUNT(*) AS c FROM chase_log WHERE invoice_id = 101").first<{ c: number }>();
      assert.strictEqual(drafts?.c, 1);
    });

    test("2.4 Enforces 7-Day Spacing Between Chases for Late-Imported Invoices", async () => {
      const { env, db } = createTestEnv();

      // Invoice imported late: 30 days overdue
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (2, 'Late Imports Ltd', 'late@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (102, 2, 'Late Debtor', 'INV-LATE-01', 150000, date('now', '-30 days'), 'overdue');
        -- Stage 1 was sent yesterday (only 1 day ago)
        INSERT INTO chase_log (invoice_id, step, status, sent_at)
        VALUES (102, 1, 'sent', datetime('now', '-1 day'));
      `);

      // Even though invoice is 30 days overdue (which exceeds CADENCE_DAYS[1]=8),
      // only 1 day has passed since Stage 1 was sent -> must wait 7 days!
      const res = await runOverdueDetection(env);
      assert.strictEqual(res.draftsCreated, 0, "Must not create Stage 2 draft before 7 days have elapsed since Stage 1");

      // Fast forward: Stage 1 was sent 8 days ago
      await db.rawSqlite.exec(`
        UPDATE chase_log SET sent_at = datetime('now', '-8 days') WHERE invoice_id = 102;
      `);

      const resAfter8d = await runOverdueDetection(env);
      assert.strictEqual(resAfter8d.draftsCreated, 1, "Should create Stage 2 draft once 7+ days have elapsed");
    });

    test("2.5 Terminal Escalation State Transition on Stage 4 Exhaustion", async () => {
      const { env, db, notify } = createTestEnv();

      // Seed invoice with Stage 4 sent 8 days ago
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (3, 'Terminal Corp', 'term@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (103, 3, 'Stubborn Debtor', 'INV-TERM-01', 200000, date('now', '-35 days'), 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at)
        VALUES (103, 4, 'sent', datetime('now', '-8 days'));
      `);

      const res = await runOverdueDetection(env);
      assert.strictEqual(res.invoicesEscalated, 1, "Invoice should be escalated after Stage 4 + 7 days");
      assert.strictEqual(res.draftsCreated, 0, "No new draft created for escalated invoice");

      // Verify invoice status updated to 'escalated' in D1
      const inv = await db.prepare("SELECT status FROM invoices WHERE id = 103").first<{ status: string }>();
      assert.strictEqual(inv?.status, "escalated");

      // Verify operator notification dispatched
      assert.ok(notify.sent.length > 0);
      assert.ok(notify.sent.some(m => m.subject.includes("INV-TERM-01 escalated")));

      // Verify subsequent cron runs ignore this invoice completely
      const resNext = await runOverdueDetection(env);
      assert.strictEqual(resNext.invoicesEscalated, 0);
      assert.strictEqual(resNext.draftsCreated, 0);
    });

    test("2.6 Stage 4 Edge Case: Grace Period & Missing sent_at Handling", async () => {
      const { env, db } = createTestEnv();

      // Sub-case A: Within 7-day grace period (Stage 4 sent 3 days ago)
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (4, 'Grace Corp', 'grace@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (104, 4, 'Grace Debtor', 'INV-GRACE-01', 75000, date('now', '-25 days'), 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at)
        VALUES (104, 4, 'sent', datetime('now', '-3 days'));
      `);

      const resA = await runOverdueDetection(env);
      assert.strictEqual(resA.invoicesEscalated, 0, "Must not escalate within 7-day grace period");
      assert.strictEqual(resA.draftsCreated, 0);

      // Sub-case B: Stage 4 has unparsable or malformed sent_at string (e.g. legacy empty string)
      // When sent_at is empty string or malformed, parseDate produces Invalid Date, diffDays yields NaN,
      // and NaN >= 7 is false. Verify it does not crash or throw unhandled error.
      await db.rawSqlite.exec(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (105, 4, 'Malformed Sent Debtor', 'INV-MALFORMED-01', 75000, date('now', '-30 days'), 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at)
        VALUES (105, 4, 'sent', 'invalid-date-format');
      `);

      const resB = await runOverdueDetection(env);
      // Ensure cron survives without throwing
      assert.strictEqual(typeof resB.draftsCreated, "number");
    });

    test("2.7 generateFallbackDraft Adheres to 4-Stage Content and Attributed Signoff", () => {
      const invRow = {
        id: 99,
        client_id: 1,
        debtor_name: "Apex Retail",
        debtor_email: "apx@test.com",
        invoice_number: "INV-9999",
        amount_pence: 450000,
        currency: "GBP",
        due_date: "2026-08-01",
        days_overdue: 45,
        company_name: "Bright Spark Ltd",
        voice_notes: null,
      };

      // Step 1: Gentle reminder
      const d1 = generateFallbackDraft(invRow, 1, 0, 4000);
      assert.ok(d1.includes("slipped through"));
      assert.ok(!d1.includes("Late Payment of Commercial Debts"));
      assert.ok(d1.includes("Tibor Rames"));
      assert.ok(d1.includes("Bright Spark Ltd"));

      // Step 2: Follow-up reminder
      const d2 = generateFallbackDraft(invRow, 2, 0, 4000);
      assert.ok(d2.includes("45 days overdue"));
      assert.ok(d2.includes("Tibor Rames"));

      // Step 3: Firm notice with statutory breakdown
      const d3 = generateFallbackDraft(invRow, 3, 5000, 7000);
      assert.ok(d3.includes("Late Payment of Commercial Debts (Interest) Act 1998"));
      assert.ok(d3.includes("statutory interest"));
      assert.ok(d3.includes("statutory compensation"));

      // Step 4: Final notice before legal hand-back
      const d4 = generateFallbackDraft(invRow, 4, 6000, 7000);
      assert.ok(d4.includes("final notice"));
      assert.ok(d4.includes("formal 7-day notice"));
      assert.ok(d4.includes("legal recovery"));
    });
  });

  // =========================================================================
  // DIMENSION 3: OAuth & Webhooks Core Engine
  // =========================================================================
  describe("3. OAuth & Webhooks Core Engine", () => {
    const secretKey = "test-encryption-key-32-chars-long!";

    test("3.1 AES-GCM-256 Token Encryption & Decryption Resilience", async () => {
      const token = "xero_access_token_super_secret_xyz123";
      const encrypted = await encryptToken(token, secretKey);

      // Roundtrip works cleanly
      const decrypted = await decryptToken(encrypted, secretKey);
      assert.strictEqual(decrypted, token);

      // Every encryption call must produce unique ciphertext (random IV)
      const encrypted2 = await encryptToken(token, secretKey);
      assert.notStrictEqual(encrypted, encrypted2, "Each encryption must use a fresh IV");

      // Corrupt base64 string -> atob throws InvalidCharacterError
      await assert.rejects(async () => {
        await decryptToken("not-valid-base64!@#$%", secretKey);
      });

      // Truncated ciphertext (< 12 bytes IV) -> subtle.decrypt throws
      const shortBytes = new Uint8Array([1, 2, 3, 4, 5]);
      const shortB64 = btoa(String.fromCharCode(...shortBytes));
      await assert.rejects(async () => {
        await decryptToken(shortB64, secretKey);
      });

      // Bit-flip tampering in ciphertext (authentication failure)
      const binary = atob(encrypted);
      const tamperedBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) tamperedBytes[i] = binary.charCodeAt(i);
      tamperedBytes[tamperedBytes.length - 1] ^= 0xff; // flip last byte
      const tamperedB64 = btoa(String.fromCharCode(...tamperedBytes));

      await assert.rejects(async () => {
        await decryptToken(tamperedB64, secretKey);
      });

      // Wrong secret key -> decryption authentication failure
      await assert.rejects(async () => {
        await decryptToken(encrypted, "wrong-secret-key-different-hash!");
      });
    });

    test("3.2 OAuth State Cryptographic Tampering & Expiration Bounds", async () => {
      const payload = { cid: 42, p: "xero" as const, ret: "/portal/connections" };
      const state = await generateOAuthState(payload, secretKey, 600); // 10 min TTL

      // Valid state verifies correctly
      const verified = await verifyOAuthState(state, secretKey, "xero");
      assert.ok(verified);
      assert.strictEqual(verified.cid, 42);
      assert.strictEqual(verified.p, "xero");

      // Provider mismatch rejects
      const wrongProvider = await verifyOAuthState(state, secretKey, "quickbooks");
      assert.strictEqual(wrongProvider, null);

      // Tampered payload in state token
      const [payloadB64, sigB64] = state.split(".");
      const decodedPayload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)!));
      decodedPayload.cid = 999; // Tamper client ID
      const tamperedPayloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(decodedPayload)));
      const tamperedState = `${tamperedPayloadB64}.${sigB64}`;

      const tamperResult = await verifyOAuthState(tamperedState, secretKey);
      assert.strictEqual(tamperResult, null, "Tampered payload must fail signature verification");

      // Tampered signature
      const badSigState = `${payloadB64}.${sigB64.slice(0, -4)}XXXX`;
      assert.strictEqual(await verifyOAuthState(badSigState, secretKey), null);

      // Expired state token (TTL = -10 seconds)
      const expiredState = await generateOAuthState(payload, secretKey, -10);
      assert.strictEqual(await verifyOAuthState(expiredState, secretKey), null, "Expired state must reject");

      // Malformed state tokens
      assert.strictEqual(await verifyOAuthState("", secretKey), null);
      assert.strictEqual(await verifyOAuthState("single-part", secretKey), null);
      assert.strictEqual(await verifyOAuthState("part1.part2.part3", secretKey), null);
    });

    test("3.3 Stripe Webhook Replay Windows & Timestamp Boundary Checking", async () => {
      const webhookSecret = "whsec_adversarial_stripe_secret_12345";
      const body = JSON.stringify({ id: "evt_123", type: "customer.subscription.updated" });
      const nowSec = Math.floor(Date.now() / 1000);

      // Helper to generate signed Stripe header
      async function makeStripeHeader(timestamp: number, payload: string, secret: string): Promise<string> {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
        const hex = Array.from(new Uint8Array(sigBuffer))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");
        return `t=${timestamp},v1=${hex}`;
      }

      // Valid current webhook
      const currentHeader = await makeStripeHeader(nowSec, body, webhookSecret);
      assert.strictEqual(await verifyWebhookSignature(body, currentHeader, webhookSecret), true);

      // Exactly 300 seconds old (upper bound of tolerance)
      const boundaryOldHeader = await makeStripeHeader(nowSec - 300, body, webhookSecret);
      assert.strictEqual(await verifyWebhookSignature(body, boundaryOldHeader, webhookSecret), true);

      // 301 seconds old (expired replay attack)
      const expiredHeader = await makeStripeHeader(nowSec - 301, body, webhookSecret);
      assert.strictEqual(await verifyWebhookSignature(body, expiredHeader, webhookSecret), false);

      // Future timestamp within 300 seconds (clock skew tolerance)
      const futureOkHeader = await makeStripeHeader(nowSec + 250, body, webhookSecret);
      assert.strictEqual(await verifyWebhookSignature(body, futureOkHeader, webhookSecret), true);

      // Future timestamp > 300 seconds (rejected)
      const futureFarHeader = await makeStripeHeader(nowSec + 301, body, webhookSecret);
      assert.strictEqual(await verifyWebhookSignature(body, futureFarHeader, webhookSecret), false);

      // Non-numeric timestamp
      assert.strictEqual(await verifyWebhookSignature(body, "t=abc,v1=123", webhookSecret), false);

      // Missing signature header or secret
      assert.strictEqual(await verifyWebhookSignature(body, null, webhookSecret), false);
      assert.strictEqual(await verifyWebhookSignature(body, currentHeader, ""), false);
    });

    test("3.4 Xero & QuickBooks Webhook HMAC Cryptographic Verification", async () => {
      const xeroKey = "xero_key_secret_888";
      const qbKey = "qb_verifier_token_777";
      const payload = JSON.stringify({ test: "adversarial_payload" });

      // Valid Xero HMAC
      const xeroSig = await signHmacSha256(payload, xeroKey);
      assert.strictEqual(await verifyXeroWebhook(payload, xeroSig, xeroKey), true);

      // Tampered Xero payload
      assert.strictEqual(await verifyXeroWebhook(payload + "tampered", xeroSig, xeroKey), false);

      // Valid QuickBooks HMAC
      const qbSig = await signHmacSha256(payload, qbKey);
      assert.strictEqual(await verifyQuickBooksWebhook(payload, qbSig, qbKey), true);

      // Tampered QuickBooks signature
      assert.strictEqual(await verifyQuickBooksWebhook(payload, "invalid_sig_base64", qbKey), false);

      // Length mismatch timing safe check
      assert.strictEqual(await verifyXeroWebhook(payload, "short", xeroKey), false);
    });

    test("3.5 SyncService External API Error Isolation", async () => {
      const { env, db } = createTestEnv();

      // Seed client and accounting connection
      const secretKey = "portal-session-secret-key-32-chars-long-12345!";
      const encAccess = await encryptToken("expired_access_token", secretKey);
      const encRefresh = await encryptToken("mock_refresh_token", secretKey);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (5, 'Sync Client', 'sync@test.com');
        INSERT INTO accounting_connections (client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (5, 'xero', 'tenant-123', '${encAccess}', '${encRefresh}', datetime('now', '-1 hour'), 'active');
      `);

      // Mock fetch to simulate 500 Internal Server Error from upstream Xero /token
      globalThis.fetch = async () => {
        return new Response("Upstream Xero Error", { status: 500 });
      };

      const syncService = new SyncService(db as unknown as D1Database, env);
      const result = await syncService.syncInvoices(5);

      // Should return structured failure without crashing
      assert.strictEqual(result.success, false);
      assert.ok(result.reason?.includes("Failed to obtain fresh access token") || result.reason?.includes("Provider fetch error"));
    });

    test("3.6 Token Refresh Race Condition Leads to Connection Revocation", async () => {
      const { env, db } = createTestEnv();
      const secretKey = "portal-session-secret-key-32-chars-long-12345!";
      const encAccess = await encryptToken("access_token_old", secretKey);
      const encRefresh = await encryptToken("refresh_token_raced", secretKey);

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (6, 'Raced Client', 'race@test.com');
        INSERT INTO accounting_connections (id, client_id, provider, tenant_id, access_token_encrypted, refresh_token_encrypted, expires_at, status)
        VALUES (60, 6, 'xero', 'tenant-race', '${encAccess}', '${encRefresh}', datetime('now', '-10 minutes'), 'active');
      `);

      // Mock fetch returning OAuth invalid_grant (simulating race condition where refresh token was already consumed)
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked or expired" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      };

      const syncService = new SyncService(db as unknown as D1Database, env);
      const res = await syncService.syncInvoices(6);

      // Verify connection is marked as 'revoked' in D1
      assert.strictEqual(res.success, false);
      const updatedConn = await db.prepare("SELECT status FROM accounting_connections WHERE id = 60").first<{ status: string }>();
      assert.strictEqual(updatedConn?.status, "revoked", "invalid_grant during refresh transitions connection status to revoked");
    });

    test("3.7 OAuth State Second-Boundary Expiration (Zero Clock Drift Grace)", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = { cid: 1, p: "xero" as const, ret: "/" };

      // State with exp = nowSec + 2 -> valid
      const validState = await generateOAuthState(payload, secretKey, 2);
      assert.ok(await verifyOAuthState(validState, secretKey));

      // State with exp = nowSec - 1 -> immediately rejected (no leeway)
      const expiredState = await generateOAuthState(payload, secretKey, -1);
      assert.strictEqual(await verifyOAuthState(expiredState, secretKey), null);
    });
  });

  // =========================================================================
  // DIMENSION 4: Email Deliverability Engine
  // =========================================================================
  describe("4. Email Deliverability Engine", () => {
    test("4.1 Transient Network Errors & Unhandled Rejection Isolation", async () => {
      const { env } = createTestEnv();

      // Simulate synchronous exception in env.NOTIFY.send
      (env.NOTIFY as any).send = () => {
        throw new Error("Synchronous network failure (socket closed)");
      };
      const notifySyncRes = await sendOperatorNotification(env, "Test Subject", "Test Body");
      assert.strictEqual(notifySyncRes, false, "Must catch synchronous error and return false");

      // Simulate asynchronous rejection in env.NOTIFY.send
      (env.NOTIFY as any).send = async () => {
        throw new Error("Asynchronous network timeout (ETIMEDOUT)");
      };
      const notifyAsyncRes = await sendOperatorNotification(env, "Test Subject", "Test Body");
      assert.strictEqual(notifyAsyncRes, false, "Must catch asynchronous rejection and return false");

      // Simulate asynchronous rejection in env.SEND.send
      (env.SEND as any).send = async () => {
        throw new Error("Upstream mail delivery failure (SMTP 550)");
      };
      const sendAsyncRes = await sendDebtorCommunication(env, "debtor@valid.com", "Subject", "Body");
      assert.strictEqual(sendAsyncRes, false, "Must catch debtor send rejection and return false");

      // Missing bindings fail closed
      const brokenEnv = { ...env, NOTIFY: undefined as any, SEND: undefined as any };
      assert.strictEqual(await sendOperatorNotification(brokenEnv, "Sub", "Body"), false);
      assert.strictEqual(await sendDebtorCommunication(brokenEnv, "debtor@valid.com", "Sub", "Body"), false);
    });

    test("4.2 Split-Trust Envelope Protection & Header Injection Sanitization", async () => {
      const { env, notify, send } = createTestEnv();

      // Verify sendOperatorNotification ALWAYS dispatches strictly to OPERATOR_INBOX_EMAIL
      await sendOperatorNotification(env, "Operator Alert", "Content");
      assert.strictEqual(notify.sent.length, 1);
      assert.strictEqual(notify.sent[0].to, OPERATOR_INBOX_EMAIL, "Operator alerts must strictly route to tiborcc2@gmail.com");
      assert.strictEqual(send.sent.length, 0, "No debtor communications sent during operator alert");

      // Email address validation tests against header injection (CRLF, semicolons, extra spaces)
      assert.strictEqual(isValidEmail("normal@company.co.uk"), true);
      assert.strictEqual(isValidEmail("first.last+tag@subdomain.example.com"), true);

      // CRLF injection attempt
      assert.strictEqual(isValidEmail("victim@example.com\r\nBcc: spy@evil.com"), false);
      assert.strictEqual(isValidEmail("victim@example.com\nSubject: Injected"), false);

      // Semicolon / multiple address injection
      assert.strictEqual(isValidEmail("victim@example.com; attacker@evil.com"), false);
      assert.strictEqual(isValidEmail("victim@example.com, attacker@evil.com"), false);

      // Malformed addresses
      assert.strictEqual(isValidEmail(""), false);
      assert.strictEqual(isValidEmail("   "), false);
      assert.strictEqual(isValidEmail("missing-domain@"), false);
      assert.strictEqual(isValidEmail("@missing-user.com"), false);
      assert.strictEqual(isValidEmail("missing-tld@domain"), false);
      assert.strictEqual(isValidEmail(null as any), false);
      assert.strictEqual(isValidEmail(undefined as any), false);

      // sendDebtorCommunication rejects invalid emails without dispatching
      const rejected = await sendDebtorCommunication(env, "invalid-email\r\n@evil.com", "Subject", "Body");
      assert.strictEqual(rejected, false);
      assert.strictEqual(send.sent.length, 0);
    });

    test("4.3 Locked Sender Model, Reply-To, & Attributed Signoff", async () => {
      const { env, send } = createTestEnv();

      // Test 1: Signoff is automatically appended when clientBusinessName is provided
      await sendDebtorCommunication(
        env,
        "debtor@client.com",
        "Overdue Notice",
        "Please settle your outstanding balance.",
        { clientBusinessName: "Delta Design Studio" }
      );

      assert.strictEqual(send.sent.length, 1);
      const msg = send.sent[0];
      assert.strictEqual(msg.from.email, LOCKED_SENDER_EMAIL);
      assert.strictEqual(msg.from.name, SENDER_NAME);
      assert.ok(msg.text?.includes("Delta Design Studio"));
      assert.ok(msg.text?.includes("Tibor Rames"));
      assert.ok(msg.text?.includes("Invoice Rescue — acting on behalf of Delta Design Studio"));

      // Test 2: If signoff is already present in body, do not duplicate
      const bodyWithSignoff = "Hello,\n\nTibor Rames\nInvoice Rescue";
      await sendDebtorCommunication(
        env,
        "debtor@client.com",
        "Notice 2",
        bodyWithSignoff,
        { clientBusinessName: "Delta Design Studio" }
      );

      const msg2 = send.sent[1];
      const countTibor = (msg2.text?.match(/Tibor Rames/g) || []).length;
      assert.strictEqual(countTibor, 1, "Signoff should not be duplicated if already present");
    });

    test("4.4 Deliverability RFC Headers & Auto-Submitted Guard against Loops", async () => {
      const { env, send, notify } = createTestEnv();

      await sendDebtorCommunication(env, "debtor@acme.com", "Important Notice", "Please see attached.");
      assert.strictEqual(send.sent.length, 1);
      const debtorMsg = send.sent[0] as any;

      // RFC 3834 Auto-Submitted header
      assert.strictEqual(debtorMsg.headers?.["Auto-Submitted"], "auto-generated");
      // Message-ID format
      assert.ok(debtorMsg.headers?.["Message-ID"]?.startsWith("<"));
      assert.ok(debtorMsg.headers?.["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));
      // Date header exists and is parseable
      assert.ok(debtorMsg.headers?.["Date"]);
      assert.ok(!isNaN(Date.parse(debtorMsg.headers?.["Date"])));
      // Reply-To matches locked sender
      assert.strictEqual(debtorMsg.headers?.["Reply-To"], LOCKED_SENDER_EMAIL);

      // Operator notification headers
      await sendOperatorNotification(env, "Operator Alert", "System check");
      assert.strictEqual(notify.sent.length, 1);
      const notifyMsg = notify.sent[0] as any;
      assert.strictEqual(notifyMsg.headers?.["Auto-Submitted"], "auto-generated");
      assert.ok(notifyMsg.headers?.["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));
    });
  });
});
