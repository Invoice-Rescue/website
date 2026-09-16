import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  sendOperatorNotification,
  sendDebtorCommunication,
  isValidEmail,
  formatDebtorSignoff,
  SENDER_NAME,
  LOCKED_SENDER_EMAIL,
  OPERATOR_INBOX_EMAIL,
} from "../backend/src/lib/email";
import { runOverdueDetection } from "../backend/src/lib/chase-runner";
import { handleApproveDraft } from "../backend/src/lib/portal-api";
import { createTestEnv, createBasicAuthHeader } from "./e2e/harness";

interface DispatchedMessage {
  to: string;
  from: { name: string; email: string };
  subject: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

describe("Milestone M4 Stress Suite — Challenger 1 (Split-Trust Email Resilience & Deliverability)", () => {
  // =========================================================================
  // SUITE 1: Email Failure Resilience in runOverdueDetection
  // =========================================================================
  describe("1. Email Failure Resilience in runOverdueDetection", () => {
    test("1.1 Network error during Stage 4 escalation does not crash cron and completes all remaining invoices", async () => {
      const { env, db } = createTestEnv();

      // Seed 4 invoices across different clients:
      // Inv 1: Stage 4 sent 10 days ago -> triggers Stage 4 escalation
      // Inv 2: Overdue 5 days -> triggers Stage 1 chase draft
      // Inv 3: Stage 4 sent 14 days ago -> triggers Stage 4 escalation
      // Inv 4: Overdue 12 days -> triggers Stage 2 chase draft
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES
          (101, 'Client One Ltd', 'c1@test.com'),
          (102, 'Client Two Ltd', 'c2@test.com'),
          (103, 'Client Three Ltd', 'c3@test.com'),
          (104, 'Client Four Ltd', 'c4@test.com');

        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status) VALUES
          (1001, 101, 'Debtor One', 'INV-ESC-01', 120000, date('now', '-35 days'), 'overdue'),
          (1002, 102, 'Debtor Two', 'INV-DRF-02', 80000, date('now', '-5 days'), 'overdue'),
          (1003, 103, 'Debtor Three', 'INV-ESC-03', 250000, date('now', '-40 days'), 'overdue'),
          (1004, 104, 'Debtor Four', 'INV-DRF-04', 150000, date('now', '-12 days'), 'overdue');

        -- Inv 1001: Stage 4 sent 10 days ago (exhausted)
        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (1001, 4, 'sent', date('now', '-10 days'), 'Final Notice 1001');

        -- Inv 1003: Stage 4 sent 14 days ago (exhausted)
        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (1003, 4, 'sent', date('now', '-14 days'), 'Final Notice 1003');

        -- Inv 1004: Stage 1 sent 10 days ago -> eligible for Stage 2
        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (1004, 1, 'sent', date('now', '-10 days'), 'Gentle Reminder 1004');
      `);

      let notifyCallCount = 0;
      // Mock env.NOTIFY to throw aggressive network / edge timeouts
      env.NOTIFY = {
        send: async (msg: any) => {
          notifyCallCount++;
          throw new Error(`ETIMEDOUT: Connection refused to Cloudflare Mail Edge on attempt ${notifyCallCount}`);
        },
      } as any;

      // Execute cron detection
      const result = await runOverdueDetection(env);

      // Verify that cron did not throw and completed full run
      assert.strictEqual(result.invoicesEscalated, 2, "Both invoices 1001 and 1003 must be escalated");
      assert.strictEqual(result.draftsCreated, 2, "Drafts for invoices 1002 and 1004 must be created");

      // Verify database state: both 1001 and 1003 must be 'escalated'
      const inv1 = await db.prepare("SELECT status FROM invoices WHERE id = 1001").first<any>();
      const inv3 = await db.prepare("SELECT status FROM invoices WHERE id = 1003").first<any>();
      assert.strictEqual(inv1.status, "escalated");
      assert.strictEqual(inv3.status, "escalated");

      // Verify chase_log drafts created for 1002 (step 1) and 1004 (step 2)
      const drafts = await db
        .prepare("SELECT invoice_id, step, status FROM chase_log WHERE status = 'draft' ORDER BY invoice_id ASC")
        .all<any>();
      assert.strictEqual(drafts.results.length, 2);
      assert.strictEqual(drafts.results[0].invoice_id, 1002);
      assert.strictEqual(drafts.results[0].step, 1);
      assert.strictEqual(drafts.results[1].invoice_id, 1004);
      assert.strictEqual(drafts.results[1].step, 2);

      // Verify notify was called for the 2 escalations and for the end-of-run digest
      assert.ok(notifyCallCount >= 3, `Expected at least 3 notification attempts, got ${notifyCallCount}`);
    });

    test("1.2 Unhandled TypeError in env.NOTIFY is safely caught by sendOperatorNotification boundary", async () => {
      const { env } = createTestEnv();

      env.NOTIFY = {
        send: async () => {
          // Simulate fatal JS runtime error in transport layer
          throw new TypeError("Cannot read properties of undefined (reading 'raw')");
        },
      } as any;

      const success = await sendOperatorNotification(env, "Subject", "Body");
      assert.strictEqual(success, false, "Must return false on runtime TypeError without rethrowing");
    });

    test("1.3 AbortError / Timeout simulation in sendOperatorNotification returns false cleanly", async () => {
      const { env } = createTestEnv();

      env.NOTIFY = {
        send: async () => {
          const domErr = new Error("The operation was aborted due to 5000ms edge deadline");
          domErr.name = "AbortError";
          throw domErr;
        },
      } as any;

      const success = await sendOperatorNotification(env, "Urgent Notice", "Payload");
      assert.strictEqual(success, false, "Must return false on AbortError");
    });
  });

  // =========================================================================
  // SUITE 2: Split-Trust Boundary Enforcement
  // =========================================================================
  describe("2. Split-Trust Boundary Enforcement", () => {
    test("2.1 sendOperatorNotification recipient is strictly immutable and hardcoded to tiborcc2@gmail.com", async () => {
      const { env, notify, send } = createTestEnv();

      // Attempt injection of external recipient through extra parameters or env manipulation
      (env as any).NOTIFY_TO = "attacker@evil.com";
      (env as any).OPERATOR_INBOX_EMAIL = "attacker@evil.com";

      // Call function (attempting to pass a 4th rogue parameter)
      const success = await (sendOperatorNotification as any)(
        env,
        "System Alert",
        "Sensitive internal payload",
        "hacker@target.org",
      );

      assert.strictEqual(success, true);
      assert.strictEqual(notify.sent.length, 1);
      assert.strictEqual(send.sent.length, 0, "env.SEND must NOT be invoked by sendOperatorNotification");

      const msg = notify.sent[0] as unknown as DispatchedMessage;
      assert.strictEqual(
        msg.to,
        "tiborcc2@gmail.com",
        "Recipient must strictly match OPERATOR_INBOX_EMAIL (tiborcc2@gmail.com)",
      );
      assert.notStrictEqual(msg.to, "attacker@evil.com");
      assert.notStrictEqual(msg.to, "hacker@target.org");
    });

    test("2.2 sendOperatorNotification never dispatches through env.SEND binding", async () => {
      const { env, send } = createTestEnv();

      let sendBindingCalled = false;
      env.SEND = {
        send: async () => {
          sendBindingCalled = true;
        },
      } as any;

      await sendOperatorNotification(env, "Alert", "Operator message");
      assert.strictEqual(sendBindingCalled, false, "env.SEND must never be called during operator notification");
    });

    test("2.3 sendDebtorCommunication never dispatches through env.NOTIFY binding", async () => {
      const { env, notify } = createTestEnv();

      let notifyBindingCalled = false;
      env.NOTIFY = {
        send: async () => {
          notifyBindingCalled = true;
        },
      } as any;

      await sendDebtorCommunication(
        env,
        "debtor@clientcompany.co.uk",
        "Outstanding Invoice",
        "Please settle your invoice.",
      );

      assert.strictEqual(notifyBindingCalled, false, "env.NOTIFY must never be called during debtor communication");
    });

    test("2.4 Missing NOTIFY binding fails closed without throwing or routing elsewhere", async () => {
      const { env, send } = createTestEnv();
      (env as any).NOTIFY = null;

      const success = await sendOperatorNotification(env, "Subject", "Body");
      assert.strictEqual(success, false);
      assert.strictEqual(send.sent.length, 0);
    });

    test("2.5 Missing SEND binding fails closed without throwing or routing elsewhere", async () => {
      const { env, notify } = createTestEnv();
      (env as any).SEND = null;

      const success = await sendDebtorCommunication(env, "client@domain.com", "Subject", "Body");
      assert.strictEqual(success, false);
      assert.strictEqual(notify.sent.length, 0);
    });
  });

  // =========================================================================
  // SUITE 3: Debtor Email Deliverability & RFC Compliance
  // =========================================================================
  describe("3. Debtor Email Deliverability & RFC Compliance", () => {
    test("3.1 Strict sender address and display name constraints", async () => {
      const { env, send } = createTestEnv();

      const success = await sendDebtorCommunication(
        env,
        "finance@debtorcorp.com",
        "Invoice Reminder INV-001",
        "Payment is overdue.",
      );

      assert.strictEqual(success, true);
      assert.strictEqual(send.sent.length, 1);

      const msg = send.sent[0] as unknown as DispatchedMessage;
      assert.strictEqual(msg.from.name, "Invoice Rescue");
      assert.strictEqual(msg.from.email, "hello@invoicerescue.co.uk");
      assert.strictEqual(msg.replyTo, "hello@invoicerescue.co.uk");
    });

    test("3.2 Full deliverability header inspection: Auto-Submitted, Message-ID, Date, Reply-To", async () => {
      const { env, send } = createTestEnv();

      const beforeTime = Date.now();
      await sendDebtorCommunication(
        env,
        "accounts@enterprise.co.uk",
        "Formal Demand",
        "Demanding payment immediately.",
      );
      const afterTime = Date.now();

      const msg = send.sent[0] as unknown as DispatchedMessage;
      assert.ok(msg.headers, "Headers object must exist");

      // 1. Auto-Submitted (RFC 3834)
      assert.strictEqual(
        msg.headers["Auto-Submitted"],
        "auto-generated",
        "Auto-Submitted header must be exactly 'auto-generated'",
      );

      // 2. Message-ID (RFC 5322)
      const messageId = msg.headers["Message-ID"];
      assert.ok(messageId, "Message-ID header must exist");
      assert.match(
        messageId,
        /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@invoicerescue\.co\.uk>$/i,
        "Message-ID must be an RFC 5322 bracketed UUID with @invoicerescue.co.uk domain",
      );

      // 3. Date (RFC 2822)
      const dateHeader = msg.headers["Date"];
      assert.ok(dateHeader, "Date header must exist");
      const parsedEpoch = Date.parse(dateHeader);
      assert.ok(!isNaN(parsedEpoch), "Date header must be valid RFC 2822 date string");
      // Must be within 5 seconds of test execution
      assert.ok(parsedEpoch >= beforeTime - 2000 && parsedEpoch <= afterTime + 2000);

      // 4. Reply-To header
      assert.strictEqual(
        msg.headers["Reply-To"],
        "hello@invoicerescue.co.uk",
        "Reply-To header must be hello@invoicerescue.co.uk",
      );
    });

    test("3.3 Message-ID uniqueness across consecutive dispatches (zero collisions)", async () => {
      const { env, send } = createTestEnv();

      const count = 50;
      for (let i = 0; i < count; i++) {
        await sendDebtorCommunication(
          env,
          `debtor${i}@example.com`,
          `Subject ${i}`,
          `Body text ${i}`,
        );
      }

      assert.strictEqual(send.sent.length, count);
      const messageIds = send.sent.map((m: any) => m.headers["Message-ID"]);
      const uniqueIds = new Set(messageIds);
      assert.strictEqual(uniqueIds.size, count, "All generated Message-IDs must be globally unique");
    });

    test("3.4 Sign-off formatting: automatically appends Tibor Rames sign-off on behalf of client", async () => {
      const { env, send } = createTestEnv();

      await sendDebtorCommunication(
        env,
        "debtor@firm.co.uk",
        "Payment Notice",
        "Dear Accounts Team,\n\nPlease find attached the statutory interest calculation.",
        { clientBusinessName: "Apex Design Studio Ltd" },
      );

      const msg = send.sent[0] as unknown as DispatchedMessage;
      const expectedSignoff = [
        "Tibor Rames",
        "Invoice Rescue — acting on behalf of Apex Design Studio Ltd",
        "hello@invoicerescue.co.uk",
      ].join("\n");

      assert.ok(
        msg.text?.includes(expectedSignoff),
        `Message body must contain exact sign-off. Received:\n${msg.text}`,
      );
    });

    test("3.5 Sign-off idempotency: does not duplicate sign-off if already present in body", async () => {
      const { env, send } = createTestEnv();

      const existingBody = `Dear Debtor,\n\nPlease settle immediately.\n\nTibor Rames\nInvoice Rescue — acting on behalf of Apex Design Studio Ltd\nhello@invoicerescue.co.uk`;

      await sendDebtorCommunication(
        env,
        "debtor@firm.co.uk",
        "Payment Notice",
        existingBody,
        { clientBusinessName: "Apex Design Studio Ltd" },
      );

      const msg = send.sent[0] as unknown as DispatchedMessage;
      const matches = msg.text?.match(/Tibor Rames/g) || [];
      assert.strictEqual(matches.length, 1, "Tibor Rames sign-off must appear exactly once");
    });

    test("3.6 Default sign-off client name when clientBusinessName is omitted or empty", () => {
      const signoffDefault = formatDebtorSignoff();
      assert.ok(signoffDefault.includes("acting on behalf of our client"));

      const signoffWhitespace = formatDebtorSignoff("   ");
      assert.ok(signoffWhitespace.includes("acting on behalf of our client"));
    });
  });

  // =========================================================================
  // SUITE 4: Invalid Debtor Email Handling & Rejection
  // =========================================================================
  describe("4. Invalid Debtor Email Handling & Boundary Validation", () => {
    test("4.1 Rejects adversarial, malformed, and injection email addresses", async () => {
      const { env, send } = createTestEnv();

      const invalidEmails = [
        "",
        "   ",
        "missingatsign.com",
        "@nodomain.com",
        "trailingat@",
        "spaces in local@domain.com",
        "user@domain with space.com",
        "user@localhost", // Missing TLD
        "user@trailingdot.",
        "user@domain\r\nBcc: victim@target.com", // CRLF injection attempt
        "user\nname@domain.com",
        "user@domain\n.com",
        null as any,
        undefined as any,
        12345 as any,
        {} as any,
      ];

      for (const badEmail of invalidEmails) {
        const isSyntaxValid = isValidEmail(badEmail);
        assert.strictEqual(
          isSyntaxValid,
          false,
          `isValidEmail should reject invalid email: ${JSON.stringify(badEmail)}`,
        );

        const sendResult = await sendDebtorCommunication(
          env,
          badEmail,
          "Notice",
          "Test message",
        );
        assert.strictEqual(
          sendResult,
          false,
          `sendDebtorCommunication should return false for invalid email: ${JSON.stringify(badEmail)}`,
        );
      }

      assert.strictEqual(send.sent.length, 0, "No emails must be sent when recipient is invalid");
    });

    test("4.2 handleApproveDraft rejects draft approval when debtor email is invalid syntax", async () => {
      const { env, db, send } = createTestEnv();

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (201, 'Bad Email Client', 'client@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (2001, 201, 'Bad Email Debtor', 'not-a-valid-email', 'INV-MALFORMED-1', 45000, date('now', '-3 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (20001, 2001, 1, 'draft', 'Re: Invoice INV-MALFORMED-1', 'Payment reminder.');
      `);

      const req = new Request("http://localhost/api/admin/drafts/20001/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });

      const res = await handleApproveDraft(req, env, "20001");
      // Must fail with 422 or 500
      assert.ok([422, 500].includes(res.status), `Expected status 422 or 500, got ${res.status}`);

      // Crucially, chase_log status MUST remain 'draft' and no email sent
      const chaseRow = await db.prepare("SELECT status FROM chase_log WHERE id = 20001").first<any>();
      assert.strictEqual(chaseRow.status, "draft", "Draft status must not transition to sent");
      assert.strictEqual(send.sent.length, 0, "No email should be dispatched");
    });
  });

  // =========================================================================
  // SUITE 5: High-Load & Unicode Stress Testing
  // =========================================================================
  describe("5. High-Load, Unicode, and Boundary Stress", () => {
    test("5.1 Handles massive 1MB email body text without crashing or truncating headers", async () => {
      const { env, send } = createTestEnv();

      const largeBody = "X".repeat(1024 * 1024); // 1 Megabyte string
      const success = await sendDebtorCommunication(
        env,
        "billing@largecorporation.co.uk",
        "Large Statement",
        largeBody,
        { clientBusinessName: "Scale Test Ltd" },
      );

      assert.strictEqual(success, true);
      assert.strictEqual(send.sent.length, 1);
      const msg = send.sent[0] as unknown as DispatchedMessage;
      assert.ok(msg.text?.length! > 1024 * 1024);
      assert.strictEqual(msg.headers?.["Auto-Submitted"], "auto-generated");
      assert.ok(msg.headers?.["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));
    });

    test("5.2 Preserves Unicode, UTF-8 symbols, emojis, and pound currency symbols", async () => {
      const { env, send, notify } = createTestEnv();

      const complexSubject = "Invoice 🚨: Overdue £1,450.75 — Société Générale & Müller GmbH";
      const complexBody = "Dear Señor José,\n\nYour invoice with statutory compensation of £70 and interest is overdue. ⚠️\nСпасибо / 谢谢.";

      // Operator notification
      const opSuccess = await sendOperatorNotification(env, complexSubject, complexBody);
      assert.strictEqual(opSuccess, true);
      const opMsg = notify.sent[0] as unknown as DispatchedMessage;
      assert.strictEqual(opMsg.subject, complexSubject);
      assert.strictEqual(opMsg.text, complexBody);

      // Debtor communication
      const debtorSuccess = await sendDebtorCommunication(
        env,
        "mueller@deutsche-firma.de",
        complexSubject,
        complexBody,
        { clientBusinessName: "Société Générale UK Ltd" },
      );
      assert.strictEqual(debtorSuccess, true);
      const debtorMsg = send.sent[0] as unknown as DispatchedMessage;
      assert.strictEqual(debtorMsg.subject, complexSubject);
      assert.ok(debtorMsg.subject.includes("£1,450.75"));
      assert.ok(debtorMsg.text?.includes("£70"));
      assert.ok(debtorMsg.text?.includes("Société Générale UK Ltd"));
      assert.ok(debtorMsg.text?.includes("Спасибо / 谢谢."));
    });
  });
});
