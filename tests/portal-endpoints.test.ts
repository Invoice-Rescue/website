import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv, createBasicAuthHeader } from "./e2e/harness";
import { buildSessionCookie } from "../backend/src/lib/portal-auth";
import worker from "../backend/src/index";

describe("Milestone M3: Portal Dashboard, Debtor Ledger & Review Queue Endpoints", () => {
  // Helper to create an authenticated client session cookie header
  async function createSessionCookieHeader(clientId: number, secret: string): Promise<string> {
    const rawCookie = await buildSessionCookie(clientId, secret);
    // Extract name=value
    const match = rawCookie.match(/^(portal_session=[^;]+)/);
    return match ? match[1] : rawCookie;
  }

  // =========================================================================
  // 1. GET /api/portal/dashboard-data
  // =========================================================================
  describe("GET /api/portal/dashboard-data", () => {
    test("1.1 Returns zeroed metrics gracefully when database is empty", async () => {
      const { env } = createTestEnv();
      const req = new Request("http://localhost/api/portal/dashboard-data", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.clientId, null);
      assert.strictEqual(json.metrics.totalOverduePence, 0);
      assert.strictEqual(json.metrics.activeChasingPence, 0);
      assert.strictEqual(json.metrics.recoveredMonthPence, 0);
      assert.strictEqual(json.metrics.overdueCount, 0);
      assert.strictEqual(json.pipeline.count, 0);
      assert.strictEqual(json.pipeline.amountPence, 0);
      assert.strictEqual(json.recentActivity.length, 0);
    });

    test("1.2 Unauthenticated request falls back to default active client in demo mode", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, plan, status, contact_email)
        VALUES (1, 'Apex Studio Ltd', 'engine', 'active', 'apex@example.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (101, 1, 'Client One Debtor', 'INV-101', 50000, '2026-08-01', 'overdue');
      `);

      const req = new Request("http://localhost/api/portal/dashboard-data", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.clientId, 1);
      assert.strictEqual(json.companyName, "Apex Studio Ltd");
      assert.strictEqual(json.plan, "engine");
      assert.strictEqual(json.metrics.totalOverduePence, 50000);
      assert.strictEqual(json.metrics.overdueCount, 1);
    });

    test("1.3 Authenticated client session cookie scopes metrics strictly to client", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, plan, status, contact_email)
        VALUES (1, 'Client One', 'foundation', 'active', 'c1@test.com'),
               (2, 'Client Two', 'operator', 'active', 'c2@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Debtor A', 'INV-1', 40000, '2026-08-01', 'overdue'),
               (2, 2, 'Debtor B', 'INV-2', 90000, '2026-08-01', 'overdue');
      `);

      const cookie = await createSessionCookieHeader(2, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/portal/dashboard-data", {
        headers: {
          Accept: "application/json",
          Cookie: cookie,
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.clientId, 2);
      assert.strictEqual(json.companyName, "Client Two");
      assert.strictEqual(json.metrics.totalOverduePence, 90000);
      assert.strictEqual(json.metrics.overdueCount, 1);
    });

    test("1.4 Rejects client session attempting cross-tenant override via query param with 403", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, status, contact_email)
        VALUES (1, 'Client One', 'active', 'c1@test.com'),
               (2, 'Client Two', 'active', 'c2@test.com');
      `);

      const cookie = await createSessionCookieHeader(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/portal/dashboard-data?client_id=2", {
        headers: {
          Accept: "application/json",
          Cookie: cookie,
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });

    test("1.5 Accurately calculates financial metrics and 4-tier aging breakdown buckets", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, plan, status, contact_email)
        VALUES (1, 'Apex Studio Ltd', 'engine', 'active', 'apex@test.com');
      `);

      // Current local date is around 2026-09-16.
      // 5 days ago: 2026-09-11 (Bucket 1: 1-7d)
      // 10 days ago: 2026-09-06 (Bucket 2: 8-14d)
      // 18 days ago: 2026-08-29 (Bucket 3: 15-21d)
      // 30 days ago: 2026-08-17 (Bucket 4: 22d+)
      await db.rawSqlite.exec(`
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status, paid_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 100000, date('now', '-5 days'), 'overdue', NULL),
               (2, 1, 'Debtor 2', 'INV-2', 200000, date('now', '-10 days'), 'promised', NULL),
               (3, 1, 'Debtor 3', 'INV-3', 300000, date('now', '-18 days'), 'disputed', NULL),
               (4, 1, 'Debtor 4', 'INV-4', 400000, date('now', '-30 days'), 'escalated', NULL),
               (5, 1, 'Debtor 5', 'INV-5', 250000, date('now', '-2 days'), 'paid', date('now', '-2 days'));
      `);

      const req = new Request("http://localhost/api/portal/dashboard-data", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      // Total overdue: 100k + 200k + 300k + 400k = 1,000,000 pence (£10,000)
      assert.strictEqual(json.metrics.totalOverduePence, 1000000);
      // Active chasing: excludes disputed (300k) -> 100k + 200k + 400k = 700,000 pence (£7,000)
      assert.strictEqual(json.metrics.activeChasingPence, 700000);
      // Recovered month: 250,000 pence (£2,500)
      assert.strictEqual(json.metrics.recoveredMonthPence, 250000);
      assert.strictEqual(json.metrics.overdueCount, 4);

      // Aging Breakdown:
      // Total overdue sum = 1,000,000
      // b1 (1-7d): 100,000 (10%)
      // b2 (8-14d): 200,000 (20%)
      // b3 (15-21d): 300,000 (30%)
      // b4 (22d+): 400,000 (40%)
      const aging = json.agingBreakdown;
      assert.strictEqual(aging.bucket1_to_7.amountPence, 100000);
      assert.strictEqual(aging.bucket1_to_7.count, 1);
      assert.strictEqual(aging.bucket1_to_7.percentage, 10);

      assert.strictEqual(aging.bucket8_to_14.amountPence, 200000);
      assert.strictEqual(aging.bucket8_to_14.count, 1);
      assert.strictEqual(aging.bucket8_to_14.percentage, 20);

      assert.strictEqual(aging.bucket15_to_21.amountPence, 300000);
      assert.strictEqual(aging.bucket15_to_21.count, 1);
      assert.strictEqual(aging.bucket15_to_21.percentage, 30);

      assert.strictEqual(aging.bucket22_plus.amountPence, 400000);
      assert.strictEqual(aging.bucket22_plus.count, 1);
      assert.strictEqual(aging.bucket22_plus.percentage, 40);
    });

    test("1.6 Returns recent activity feed from chase_log sorted chronologically", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client Act', 'act@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (10, 1, 'Debtor Act', 'INV-ACT-1', 1230000, '2026-08-01');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, sent_at, reviewed_at)
        VALUES (1, 10, 1, 'email', 'sent', '2026-09-10 10:00:00', '2026-09-10 10:05:00'),
               (2, 10, 2, 'email', 'sent', '2026-09-16 08:30:00', '2026-09-16 08:30:00');
      `);

      const req = new Request("http://localhost/api/portal/dashboard-data", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.recentActivity.length, 2);
      assert.strictEqual(json.recentActivity[0].id, "chase_2");
      assert.strictEqual(json.recentActivity[0].title, "Stage 2 dispatched");
      assert.strictEqual(json.recentActivity[0].detail, "INV-ACT-1 (Debtor Act)");
      assert.strictEqual(json.recentActivity[0].amountPence, 1230000);
      assert.strictEqual(json.recentActivity[0].amount, "£12,300.00");
    });
  });

  // =========================================================================
  // 2. GET /api/portal/debtors
  // =========================================================================
  describe("GET /api/portal/debtors", () => {
    test("2.1 Returns debtor ledger with calculated days_overdue, stage, and stage_label", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Hartley & Co Ltd', 'accounts@hartley.co.uk', 'INV-2026-089', 485000, date('now', '-24 days'), 'overdue');
      `);

      const req = new Request("http://localhost/api/portal/debtors", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.debtors.length, 1);
      const debtor = json.debtors[0];
      assert.strictEqual(debtor.invoice_number, "INV-2026-089");
      assert.strictEqual(debtor.debtor_name, "Hartley & Co Ltd");
      assert.strictEqual(debtor.debtor_email, "accounts@hartley.co.uk");
      assert.strictEqual(debtor.amount_pence, 485000);
      assert.strictEqual(debtor.days_overdue, 24);
      assert.strictEqual(debtor.stage, 4);
      assert.strictEqual(debtor.stage_label, "Stage 4 (Final)");
      assert.strictEqual(debtor.status, "overdue");
    });

    test("2.2 Search filter matches debtor name, invoice number, or email", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Alpha Corp', 'alpha@corp.test', 'INV-100', 10000, '2026-08-01', 'overdue'),
               (2, 1, 'Beta Industries', 'finance@beta.test', 'INV-200', 20000, '2026-08-01', 'overdue'),
               (3, 1, 'Gamma Solutions', 'accounts@gamma.test', 'INV-300', 30000, '2026-08-01', 'overdue');
      `);

      // Search by name
      const reqName = new Request("http://localhost/api/portal/debtors?search=Alpha", {
        headers: { Accept: "application/json" },
      });
      const resName = await worker.fetch(reqName, env);
      const jsonName = await resName.json() as any;
      assert.strictEqual(jsonName.debtors.length, 1);
      assert.strictEqual(jsonName.debtors[0].invoice_number, "INV-100");

      // Search by invoice number
      const reqInv = new Request("http://localhost/api/portal/debtors?q=INV-200", {
        headers: { Accept: "application/json" },
      });
      const resInv = await worker.fetch(reqInv, env);
      const jsonInv = await resInv.json() as any;
      assert.strictEqual(jsonInv.debtors.length, 1);
      assert.strictEqual(jsonInv.debtors[0].debtor_name, "Beta Industries");

      // Search by email
      const reqEmail = new Request("http://localhost/api/portal/debtors?search=gamma.test", {
        headers: { Accept: "application/json" },
      });
      const resEmail = await worker.fetch(reqEmail, env);
      const jsonEmail = await resEmail.json() as any;
      assert.strictEqual(jsonEmail.debtors.length, 1);
      assert.strictEqual(jsonEmail.debtors[0].debtor_name, "Gamma Solutions");
    });

    test("2.3 Filters debtors by stage and status", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'D1', 'INV-1', 10000, date('now', '-5 days'), 'overdue'),
               (2, 1, 'D2', 'INV-2', 20000, date('now', '-25 days'), 'overdue'),
               (3, 1, 'D3', 'INV-3', 30000, date('now', '-25 days'), 'paid');
      `);

      // Stage 1 filter (5 days overdue)
      const resStage1 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=1", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonStage1 = await resStage1.json() as any;
      assert.strictEqual(jsonStage1.debtors.length, 1);
      assert.strictEqual(jsonStage1.debtors[0].invoice_number, "INV-1");

      // Status paid filter
      const resPaid = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?status=paid", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonPaid = await resPaid.json() as any;
      assert.strictEqual(jsonPaid.debtors.length, 1);
      assert.strictEqual(jsonPaid.debtors[0].invoice_number, "INV-3");
    });

    test("2.4 Multi-column sorting: days_overdue, amount_pence, debtor_name (ASC/DESC)", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Zulu Corp', 'INV-Z', 50000, date('now', '-10 days'), 'overdue'),
               (2, 1, 'Alpha Corp', 'INV-A', 10000, date('now', '-30 days'), 'overdue');
      `);

      // Sort by debtor_name asc
      const resAlpha = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=debtor_name&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAlpha = await resAlpha.json() as any;
      assert.strictEqual(jsonAlpha.debtors[0].debtor_name, "Alpha Corp");

      // Sort by amount_pence desc
      const resAmount = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=amount_pence&dir=desc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAmount = await resAmount.json() as any;
      assert.strictEqual(jsonAmount.debtors[0].invoice_number, "INV-Z");
    });

    test("2.5 Strict multi-tenant isolation: Client 1 cannot view Client 2 debtors", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com'), (2, 'C2', 'c2@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Client 1 Secret Debtor', 'INV-C1', 10000, '2026-08-01', 'overdue'),
               (2, 2, 'Client 2 Secret Debtor', 'INV-C2', 20000, '2026-08-01', 'overdue');
      `);

      const cookie1 = await createSessionCookieHeader(1, env.PORTAL_SESSION_SECRET);
      const res1 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors", { headers: { Accept: "application/json", Cookie: cookie1 } }),
        env,
      );
      const json1 = await res1.json() as any;
      assert.strictEqual(json1.debtors.length, 1);
      assert.strictEqual(json1.debtors[0].invoice_number, "INV-C1");

      // Attempting to request client_id=2 with client 1 session returns 403 Forbidden
      const resForbidden = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?client_id=2", { headers: { Accept: "application/json", Cookie: cookie1 } }),
        env,
      );
      assert.strictEqual(resForbidden.status, 403);
    });
  });

  // =========================================================================
  // 3. GET /api/admin/drafts & GET /api/chase/queue
  // =========================================================================
  describe("GET /api/admin/drafts & GET /api/chase/queue", () => {
    test("3.1 Returns unapproved drafts with full statutory calculation breakdown", async () => {
      const { env, db } = createTestEnv({ BOE_BASE_RATE_PERCENT: "3.75" });
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Studio Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES (1, 1, 'Hartley & Co Ltd', 'accounts@hartley.co.uk', 'INV-2026-089', 485000, date('now', '-24 days'), 'overdue');
        INSERT INTO chase_log (id, invoice_id, step, channel, status, subject, body, sent_at)
        VALUES (101, 1, 4, 'email', 'draft', 'FINAL DEMAND — INV-2026-089', 'Please pay immediately.', '2026-09-14 08:00:00');
      `);

      const req = new Request("http://localhost/api/admin/drafts", {
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.drafts.length, 1);
      const draft = json.drafts[0];
      assert.strictEqual(draft.id, 101);
      assert.strictEqual(draft.invoice_number, "INV-2026-089");
      assert.strictEqual(draft.debtor_name, "Hartley & Co Ltd");
      assert.strictEqual(draft.company_name, "Apex Studio Ltd");
      assert.strictEqual(draft.principal_pence, 485000);
      assert.strictEqual(draft.days_overdue, 24);
      assert.strictEqual(draft.step, 4);
      assert.strictEqual(draft.step_label, "Stage 4 (Final Notice)");
      assert.strictEqual(draft.locked_sender, env.NOTIFY_FROM);

      // Statutory calculations:
      // Amount is £4,850.00 (<£10,000 and >=£1,000) -> Fixed compensation is £70.00 (7,000 pence)
      assert.strictEqual(draft.fixed_compensation_pence, 7000);

      // Interest: (485,000 * (3.75 + 8) / 100 / 365) * 24 = Math.round(3747.287...) = 3747 pence
      assert.strictEqual(draft.statutory_interest_pence, 3747);

      // Total claim: 485,000 + 7,000 + 3,747 = 495,747 pence
      assert.strictEqual(draft.total_claim_pence, 495747);
    });

    test("3.2 Route alias GET /api/chase/queue behaves identically to /api/admin/drafts", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-10 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body)
        VALUES (10, 1, 1, 'draft', 'Draft body');
      `);

      const req = new Request("http://localhost/api/chase/queue", {
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.drafts.length, 1);
      assert.strictEqual(json.drafts[0].id, 10);
    });

    test("3.3 Returns 401 Unauthorized when unauthenticated", async () => {
      const { env } = createTestEnv();
      const req = new Request("http://localhost/api/admin/drafts", {
        headers: { Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401);
    });
  });

  // =========================================================================
  // 4. POST /api/admin/drafts/:id/approve & POST /api/chase/:id/approve
  // =========================================================================
  describe("POST /api/admin/drafts/:id/approve & POST /api/chase/:id/approve", () => {
    test("4.1 Approves draft with JSON body, dispatches email via env.SEND, updates status to 'sent'", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor Co', 'debtor@test.com', 'INV-APP-1', 100000, date('now', '-10 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (50, 1, 2, 'draft', 'Original Subject', 'Original Body Text');
      `);

      const req = new Request("http://localhost/api/admin/drafts/50/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "Operator customized message body." }),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.draft_id, 50);
      assert.strictEqual(json.status, "sent");

      // Verify email mock
      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].to, "debtor@test.com");
      assert.strictEqual(send.sent[0].from.name, "Invoice Rescue");
      assert.strictEqual(send.sent[0].from.email, env.NOTIFY_FROM);
      assert.strictEqual(send.sent[0].text, "Operator customized message body.");

      // Verify DB update
      const row = await db.prepare("SELECT status, body, outcome, reviewed_by FROM chase_log WHERE id = 50").first<any>();
      assert.strictEqual(row.status, "sent");
      assert.strictEqual(row.body, "Operator customized message body.");
      assert.strictEqual(row.outcome, "sent");
      assert.strictEqual(row.reviewed_by, "Tibor Rames");
    });

    test("4.2 Approves draft with form urlencoded body via legacy route alias /api/chase/:id/approve", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'debtor1@test.com', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body)
        VALUES (60, 1, 1, 'draft', 'Old Body');
      `);

      const req = new Request("http://localhost/api/chase/60/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "body=Form+encoded+revised+text",
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].text, "Form encoded revised text");
    });

    test("4.3 Unedited approval preserves draft body verbatim", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'debtor1@test.com', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body)
        VALUES (70, 1, 1, 'draft', 'Keep this existing body.');
      `);

      const req = new Request("http://localhost/api/admin/drafts/70/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].text, "Keep this existing body.");
    });

    test("4.4 Returns 404 when draft does not exist or was already reviewed", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'd@test.com', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (80, 1, 1, 'sent');
      `);

      // Non-existent ID
      const resNonExistent = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/999999/approve", {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(resNonExistent.status, 404);

      // Already reviewed (status = 'sent')
      const resAlreadySent = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/80/approve", {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(resAlreadySent.status, 404);
    });

    test("4.5 Returns 422 Unprocessable Entity when debtor email is missing", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor No Email', NULL, 'INV-NO-EMAIL', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (90, 1, 1, 'draft');
      `);

      const req = new Request("http://localhost/api/admin/drafts/90/approve", {
        method: "POST",
        headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 422);
    });

    test("4.6 Returns 403 Forbidden when client session attempts to approve another tenant's draft", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com'), (2, 'C2', 'c2@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'C1 Debtor', 'c1d@test.com', 'INV-1', 50000, date('now', '-5 days')),
               (2, 2, 'C2 Debtor', 'c2d@test.com', 'INV-2', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (101, 1, 1, 'draft'), (201, 2, 1, 'draft');
      `);

      // Client 1 attempts to approve Client 2's draft (id: 201)
      const cookie1 = await createSessionCookieHeader(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/admin/drafts/201/approve", {
        method: "POST",
        headers: { Cookie: cookie1, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // 5. POST /api/admin/drafts/:id/skip & POST /api/chase/:id/skip
  // =========================================================================
  describe("POST /api/admin/drafts/:id/skip & POST /api/chase/:id/skip", () => {
    test("5.1 Skips draft, sets status to 'skipped' and stamps reviewed_at without sending emails", async () => {
      const { env, db, send, notify } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (110, 1, 1, 'draft');
      `);

      const req = new Request("http://localhost/api/admin/drafts/110/skip", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.status, "skipped");

      assert.strictEqual(send.sent.length, 0);
      assert.strictEqual(notify.sent.length, 0);

      const row = await db.prepare("SELECT status, reviewed_at FROM chase_log WHERE id = 110").first<any>();
      assert.strictEqual(row.status, "skipped");
      assert.ok(row.reviewed_at !== null);
    });

    test("5.2 Idempotent skip on already skipped draft returns 200", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (120, 1, 1, 'skipped');
      `);

      const req = new Request("http://localhost/api/admin/drafts/120/skip", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);
    });

    test("5.3 Returns 404 when draft ID does not exist", async () => {
      const { env } = createTestEnv();
      const req = new Request("http://localhost/api/admin/drafts/999999/skip", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 404);
    });
  });

  // =========================================================================
  // 6. PUT /api/admin/drafts/:id & PUT /api/chase/:id
  // =========================================================================
  describe("PUT /api/admin/drafts/:id & PUT /api/chase/:id", () => {
    test("6.1 Updates draft message body and subject in chase_log in-place", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (130, 1, 1, 'draft', 'Old Subject', 'Old Body');
      `);

      const req = new Request("http://localhost/api/admin/drafts/130", {
        method: "PUT",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: "Updated in-place message text.",
          subject: "Updated Subject Line",
        }),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);

      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.body, "Updated in-place message text.");
      assert.strictEqual(json.subject, "Updated Subject Line");

      const row = await db.prepare("SELECT body, subject, status FROM chase_log WHERE id = 130").first<any>();
      assert.strictEqual(row.body, "Updated in-place message text.");
      assert.strictEqual(row.subject, "Updated Subject Line");
      assert.strictEqual(row.status, "draft"); // Still in draft status awaiting review!
    });

    test("6.2 Returns 400 Bad Request when body is empty or whitespace only", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (140, 1, 1, 'draft');
      `);

      const req = new Request("http://localhost/api/admin/drafts/140", {
        method: "PUT",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "   " }),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 400);
    });

    test("6.3 Returns 404 when draft does not exist or was already reviewed", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (150, 1, 1, 'sent');
      `);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/150", {
          method: "PUT",
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: "Some text" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 404);
    });

    test("6.4 Returns 403 when client session attempts to edit another client's draft", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com'), (2, 'C2', 'c2@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'D1', 'INV-1', 50000, date('now', '-5 days')),
               (2, 2, 'D2', 'INV-2', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status) VALUES (160, 2, 1, 'draft');
      `);

      const cookie1 = await createSessionCookieHeader(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/160", {
          method: "PUT",
          headers: {
            Cookie: cookie1,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: "Tampered text" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 403);
    });
  });
});
