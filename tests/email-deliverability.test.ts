import { describe, test } from "node:test";
import assert from "node:assert";
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

interface MessageWithHeaders {
  to: string;
  from: { name: string; email: string };
  subject: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

describe("Milestone M4: Email Deliverability & Split-Trust Controls", () => {
  // =========================================================================
  // 1. sendOperatorNotification Unit Tests
  // =========================================================================
  describe("sendOperatorNotification", () => {
    test("1.1 Sends via env.NOTIFY to operator address (tiborcc2@gmail.com) with locked sender", async () => {
      const { env, notify } = createTestEnv();

      const success = await sendOperatorNotification(
        env,
        "System Alert: Queue Digest",
        "There are 3 drafts waiting for operator review.",
      );

      assert.strictEqual(success, true);
      assert.strictEqual(notify.sent.length, 1);

      const msg = notify.sent[0] as unknown as MessageWithHeaders;
      assert.strictEqual(msg.to, OPERATOR_INBOX_EMAIL);
      assert.strictEqual(msg.to, "tiborcc2@gmail.com");
      assert.strictEqual(msg.from.name, SENDER_NAME);
      assert.strictEqual(msg.from.email, LOCKED_SENDER_EMAIL);
      assert.strictEqual(msg.subject, "System Alert: Queue Digest");
      assert.strictEqual(msg.text, "There are 3 drafts waiting for operator review.");
    });

    test("1.2 Injects RFC deliverability headers: Auto-Submitted, Message-ID, and Date", async () => {
      const { env, notify } = createTestEnv();

      const success = await sendOperatorNotification(
        env,
        "Test Subject",
        "Body content.",
      );
      assert.strictEqual(success, true);

      const msg = notify.sent[0] as unknown as MessageWithHeaders;
      assert.ok(msg.headers, "Message must have headers property");

      // Auto-Submitted header prevents vacation mail loops (RFC 3834)
      assert.strictEqual(msg.headers["Auto-Submitted"], "auto-generated");

      // Message-ID header (RFC 5322)
      const messageId = msg.headers["Message-ID"];
      assert.ok(messageId, "Must generate Message-ID header");
      assert.ok(messageId.startsWith("<"), "Message-ID must start with <");
      assert.ok(messageId.endsWith("@invoicerescue.co.uk>"), "Message-ID must end with @invoicerescue.co.uk>");
      const uuidPart = messageId.slice(1, -"@invoicerescue.co.uk>".length);
      assert.match(
        uuidPart,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "Message-ID must contain a valid UUID",
      );

      // Date header (RFC 2822)
      const dateHeader = msg.headers["Date"];
      assert.ok(dateHeader, "Must generate Date header");
      assert.ok(!isNaN(Date.parse(dateHeader)), "Date header must be valid RFC 2822 date");
    });

    test("1.3 Resilient error handling: returns false and never throws on transient send failure", async () => {
      const { env } = createTestEnv();

      // Simulate transient email service error
      env.NOTIFY = {
        send: async () => {
          throw new Error("Temporary network timeout communicating with mail edge");
        },
      } as any;

      let threw = false;
      let result = false;
      try {
        result = await sendOperatorNotification(
          env,
          "Failing Notification",
          "Should not throw exception.",
        );
      } catch {
        threw = true;
      }

      assert.strictEqual(threw, false, "sendOperatorNotification must not throw on error");
      assert.strictEqual(result, false, "sendOperatorNotification must return false on error");
    });

    test("1.4 Gracefully handles undefined or missing env.NOTIFY binding", async () => {
      const { env } = createTestEnv();
      (env as any).NOTIFY = undefined;

      const result = await sendOperatorNotification(
        env,
        "No Binding Alert",
        "Should return false safely.",
      );
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // 2. sendDebtorCommunication Unit Tests
  // =========================================================================
  describe("sendDebtorCommunication", () => {
    test("2.1 Sends via env.SEND with locked sender hello@invoicerescue.co.uk and deliverability headers", async () => {
      const { env, send } = createTestEnv();

      const success = await sendDebtorCommunication(
        env,
        "accounts@debtor.example.com",
        "Overdue Invoice INV-2024",
        "Dear Accounts,\n\nPlease settle this invoice at your earliest convenience.",
      );

      assert.strictEqual(success, true);
      assert.strictEqual(send.sent.length, 1);

      const msg = send.sent[0] as unknown as MessageWithHeaders;
      assert.strictEqual(msg.to, "accounts@debtor.example.com");
      assert.strictEqual(msg.from.name, SENDER_NAME);
      assert.strictEqual(msg.from.email, LOCKED_SENDER_EMAIL);
      assert.strictEqual(msg.replyTo, LOCKED_SENDER_EMAIL);

      // Deliverability headers
      assert.ok(msg.headers);
      assert.strictEqual(msg.headers["Auto-Submitted"], "auto-generated");
      assert.strictEqual(msg.headers["Reply-To"], LOCKED_SENDER_EMAIL);
      assert.ok(msg.headers["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));
      assert.ok(!isNaN(Date.parse(msg.headers["Date"] ?? "")));
    });

    test("2.2 Appends Tibor Rames sign-off when options.clientBusinessName is provided", async () => {
      const { env, send } = createTestEnv();

      const success = await sendDebtorCommunication(
        env,
        "finance@client-debtor.com",
        "Stage 2 Reminder",
        "This is an overdue reminder.",
        { clientBusinessName: "Acme Creative Ltd" },
      );

      assert.strictEqual(success, true);
      const msg = send.sent[0] as unknown as MessageWithHeaders;
      assert.ok(msg.text?.includes("This is an overdue reminder."));
      assert.ok(msg.text?.includes("Tibor Rames"));
      assert.ok(msg.text?.includes("Invoice Rescue — acting on behalf of Acme Creative Ltd"));
      assert.ok(msg.text?.includes(LOCKED_SENDER_EMAIL));
    });

    test("2.3 Does not duplicate sign-off if body already includes Tibor Rames sign-off", async () => {
      const { env, send } = createTestEnv();

      const preSignedBody = [
        "Dear Debtor,",
        "",
        "Please pay.",
        "",
        "Tibor Rames",
        "Invoice Rescue — acting on behalf of Acme Creative Ltd",
        "hello@invoicerescue.co.uk",
      ].join("\n");

      await sendDebtorCommunication(
        env,
        "finance@client-debtor.com",
        "Subject",
        preSignedBody,
        { clientBusinessName: "Acme Creative Ltd" },
      );

      const msg = send.sent[0] as unknown as MessageWithHeaders;
      // Should contain "Tibor Rames" exactly once
      const matches = msg.text?.match(/Tibor Rames/g) ?? [];
      assert.strictEqual(matches.length, 1, "Sign-off must not be duplicated");
    });

    test("2.4 Validates debtor recipient email and rejects invalid addresses", async () => {
      const { env, send } = createTestEnv();

      const invalidAddresses = [
        "",
        "   ",
        "not-an-email",
        "@no-user.com",
        "no-domain@",
        "spaces in@email.com",
      ];

      for (const bad of invalidAddresses) {
        const result = await sendDebtorCommunication(
          env,
          bad,
          "Subject",
          "Body",
        );
        assert.strictEqual(result, false, `Should reject invalid email: '${bad}'`);
      }
      assert.strictEqual(send.sent.length, 0, "No emails should be dispatched for invalid recipients");
    });

    test("2.5 Resilient error handling: returns false and never throws on transient send failure", async () => {
      const { env } = createTestEnv();
      env.SEND = {
        send: async () => {
          throw new Error("Rate limit exceeded on SendEmail binding");
        },
      } as any;

      let threw = false;
      let result = false;
      try {
        result = await sendDebtorCommunication(
          env,
          "debtor@target.com",
          "Subject",
          "Body",
        );
      } catch {
        threw = true;
      }

      assert.strictEqual(threw, false);
      assert.strictEqual(result, false);
    });

    test("2.6 Gracefully handles missing env.SEND binding", async () => {
      const { env } = createTestEnv();
      (env as any).SEND = undefined;

      const result = await sendDebtorCommunication(
        env,
        "debtor@target.com",
        "Subject",
        "Body",
      );
      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // 3. Integration with Chase Runner & Portal API
  // =========================================================================
  describe("Integration & Cron Reliability", () => {
    test("3.1 runOverdueDetection terminal escalation notifies operator via sendOperatorNotification", async () => {
      const { env, db, notify } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (77, 'Omega Corp', 'omega@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (777, 77, 'Omega Debtor', 'INV-TERM-777', 150000, date('now', '-30 days'), 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (777, 4, 'sent', date('now', '-8 days'), 'Final Notice Stage 4');
      `);

      const result = await runOverdueDetection(env);
      assert.strictEqual(result.invoicesEscalated, 1);

      // Verify invoice status updated
      const inv = await db.prepare("SELECT status FROM invoices WHERE id = 777").first<any>();
      assert.strictEqual(inv.status, "escalated");

      // Verify operator alert sent via sendOperatorNotification with deliverability headers
      assert.strictEqual(notify.sent.length, 1);
      const alert = notify.sent[0] as unknown as MessageWithHeaders;
      assert.strictEqual(alert.to, "tiborcc2@gmail.com");
      assert.ok(alert.subject.includes("INV-TERM-777 escalated (Stage 4 exhausted)"));
      assert.strictEqual(alert.headers?.["Auto-Submitted"], "auto-generated");
      assert.ok(alert.headers?.["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));
    });

    test("3.2 runOverdueDetection does not crash when operator notification throws", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (88, 'Crash Test Corp', 'ct@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (888, 88, 'Crash Debtor', 'INV-CRASH-888', 250000, date('now', '-30 days'), 'overdue');
        INSERT INTO chase_log (invoice_id, step, status, sent_at, body)
        VALUES (888, 4, 'sent', date('now', '-8 days'), 'Final Notice');
      `);

      // Intentionally cause env.NOTIFY to fail
      env.NOTIFY = {
        send: async () => {
          throw new Error("Simulated Cloudflare edge outage on NOTIFY binding");
        },
      } as any;

      // Cron should succeed without throwing
      const result = await runOverdueDetection(env);
      assert.strictEqual(result.invoicesEscalated, 1);

      const inv = await db.prepare("SELECT status FROM invoices WHERE id = 888").first<any>();
      assert.strictEqual(inv.status, "escalated");
    });

    test("3.3 handleApproveDraft uses sendDebtorCommunication and injects deliverability headers", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (99, 'Solaris Ltd', 'solaris@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (999, 99, 'Solaris Debtor', 'accounts@solarisdebtor.co.uk', 'INV-SOL-999', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (990, 999, 1, 'draft', 'Re: Invoice INV-SOL-999', 'Please pay promptly.');
      `);

      const req = new Request("http://localhost/api/admin/drafts/990/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });

      const res = await handleApproveDraft(req, env, "990");
      assert.strictEqual(res.status, 200);

      // Verify email dispatched
      assert.strictEqual(send.sent.length, 1);
      const sentMsg = send.sent[0] as unknown as MessageWithHeaders;
      assert.strictEqual(sentMsg.to, "accounts@solarisdebtor.co.uk");
      assert.strictEqual(sentMsg.from.name, SENDER_NAME);
      assert.strictEqual(sentMsg.from.email, LOCKED_SENDER_EMAIL);
      assert.strictEqual(sentMsg.replyTo, LOCKED_SENDER_EMAIL);
      assert.strictEqual(sentMsg.headers?.["Auto-Submitted"], "auto-generated");
      assert.strictEqual(sentMsg.headers?.["Reply-To"], LOCKED_SENDER_EMAIL);
      assert.ok(sentMsg.headers?.["Message-ID"]?.endsWith("@invoicerescue.co.uk>"));

      // Verify database updated to status='sent'
      const chaseRow = await db.prepare("SELECT status, outcome FROM chase_log WHERE id = 990").first<any>();
      assert.strictEqual(chaseRow.status, "sent");
      assert.strictEqual(chaseRow.outcome, "sent");
    });

    test("3.4 handleApproveDraft maintains draft status if email dispatch fails", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (98, 'Titan Ltd', 'titan@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (998, 98, 'Titan Debtor', 'accounts@titandebtor.co.uk', 'INV-TITAN-998', 75000, date('now', '-7 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (980, 998, 1, 'draft', 'Re: Invoice INV-TITAN-998', 'Payment required.');
      `);

      // Mock email sending failure
      env.SEND = {
        send: async () => {
          throw new Error("Mail submission rejected by edge");
        },
      } as any;

      const req = new Request("http://localhost/api/admin/drafts/980/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });

      const res = await handleApproveDraft(req, env, "980");
      assert.strictEqual(res.status, 500);

      // Draft status MUST NOT be 'sent' (transactional integrity)
      const chaseRow = await db.prepare("SELECT status FROM chase_log WHERE id = 980").first<any>();
      assert.strictEqual(chaseRow.status, "draft");
    });
  });

  // =========================================================================
  // 4. Migration 0007 Query Indices Verification
  // =========================================================================
  describe("Migration 0007 Query Indices", () => {
    test("4.1 Migration 0007 creates all required indices in database schema", () => {
      const { db } = createTestEnv();

      // Query sqlite_master to verify index creation
      const indices = db.rawSqlite
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string; tbl_name: string }>;

      const indexNames = indices.map((i) => i.name);
      assert.ok(indexNames.includes("idx_chase_log_status"), "idx_chase_log_status must exist");
      assert.ok(
        indexNames.includes("idx_accounting_connections_lookup"),
        "idx_accounting_connections_lookup must exist",
      );
      assert.ok(indexNames.includes("idx_clients_status"), "idx_clients_status must exist");
      assert.ok(indexNames.includes("idx_invoices_client_due"), "idx_invoices_client_due must exist");
    });

    test("4.2 EXPLAIN QUERY PLAN confirms query index usage without table scans", () => {
      const { db } = createTestEnv();

      // 1. chase_log status lookup
      const chasePlan = db.rawSqlite
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM chase_log WHERE status = 'draft'")
        .all() as Array<{ detail: string }>;
      assert.ok(
        chasePlan.some((p) => p.detail.includes("idx_chase_log_status")),
        `chase_log query must use idx_chase_log_status: ${JSON.stringify(chasePlan)}`,
      );

      // 2. accounting_connections lookup by provider and tenant_id
      const acctPlan = db.rawSqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT client_id FROM accounting_connections WHERE provider = 'xero' AND tenant_id = 't_123'",
        )
        .all() as Array<{ detail: string }>;
      assert.ok(
        acctPlan.some((p) => p.detail.includes("idx_accounting_connections_lookup")),
        `accounting_connections query must use idx_accounting_connections_lookup: ${JSON.stringify(acctPlan)}`,
      );

      // 3. clients status lookup
      const clientPlan = db.rawSqlite
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM clients WHERE status = 'active'")
        .all() as Array<{ detail: string }>;
      assert.ok(
        clientPlan.some((p) => p.detail.includes("idx_clients_status")),
        `clients query must use idx_clients_status: ${JSON.stringify(clientPlan)}`,
      );

      // 4. invoices client_id with due_date DESC order
      const invoicePlan = db.rawSqlite
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM invoices WHERE client_id = 1 ORDER BY due_date DESC",
        )
        .all() as Array<{ detail: string }>;
      assert.ok(
        invoicePlan.some((p) => p.detail.includes("idx_invoices_client_due")),
        `invoices query must use idx_invoices_client_due: ${JSON.stringify(invoicePlan)}`,
      );
      // Ensure no temp B-tree is required for ordering
      assert.ok(
        !invoicePlan.some((p) => p.detail.includes("USE TEMP B-TREE")),
        "invoices query with composite index must not use temporary B-tree for ORDER BY",
      );
    });
  });
});
