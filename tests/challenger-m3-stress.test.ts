import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv, createBasicAuthHeader } from "./e2e/harness";
import { buildSessionCookie, signLoginToken } from "../backend/src/lib/portal-auth";
import worker from "../backend/src/index";
import { fixedCompensationPence, statutoryInterestPence } from "../backend/src/lib/statutory-interest";

describe("Milestone M3 Stress Suite — Challenger 1 (Portal & Queue Concurrency Stress - R3)", () => {
  // Helper to construct authenticated client session cookie header
  async function createSessionCookie(clientId: number, secret: string): Promise<string> {
    const raw = await buildSessionCookie(clientId, secret);
    const match = raw.match(/^(portal_session=[^;]+)/);
    return match ? match[1] : raw;
  }

  // Helper to construct authenticated client Bearer authorization header
  async function createBearerAuthHeader(clientId: number, secret: string): Promise<string> {
    const rawCookie = await buildSessionCookie(clientId, secret);
    const token = rawCookie.split("portal_session=")[1].split(";")[0];
    return `Bearer ${token}`;
  }

  // =========================================================================
  // SUITE 1: Multi-Tenant Isolation Under Adversarial Probing
  // =========================================================================
  describe("1. Multi-Tenant Isolation Probing", () => {
    async function seedMultiTenantData(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, plan, status, contact_email)
        VALUES (1, 'Alpha Corp', 'foundation', 'active', 'alpha@corp.com'),
               (2, 'Beta Ltd', 'engine', 'active', 'beta@ltd.com'),
               (3, 'Gamma Inc', 'operator', 'active', 'gamma@inc.com');

        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES
          (10, 1, 'Alpha Debtor 1', 'deb1@alpha.com', 'INV-ALPHA-01', 100000, date('now', '-5 days'), 'overdue'),
          (11, 1, 'Alpha Debtor 2', 'deb2@alpha.com', 'INV-ALPHA-02', 200000, date('now', '-15 days'), 'overdue'),
          (20, 2, 'Beta Debtor 1', 'deb1@beta.com', 'INV-BETA-01', 500000, date('now', '-10 days'), 'overdue'),
          (21, 2, 'Beta Debtor 2', 'deb2@beta.com', 'INV-BETA-02', 750000, date('now', '-25 days'), 'overdue'),
          (30, 3, 'Gamma Debtor 1', 'deb1@gamma.com', 'INV-GAMMA-01', 990000, date('now', '-8 days'), 'overdue');

        INSERT INTO chase_log (id, invoice_id, step, channel, status, subject, body, sent_at)
        VALUES
          (100, 10, 1, 'email', 'draft', 'Alpha Reminder', 'Dear Alpha Debtor 1, please settle.', '2026-09-15 10:00:00'),
          (200, 20, 2, 'email', 'draft', 'Beta Follow-up', 'Dear Beta Debtor 1, second notice.', '2026-09-15 11:00:00'),
          (300, 30, 1, 'email', 'draft', 'Gamma Notice', 'Dear Gamma Debtor 1, please pay.', '2026-09-15 12:00:00');
      `);
    }

    test("1.1 Tenant A session cookie attempting to access Tenant B dashboard via ?client_id=2 returns 403 Forbidden", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/portal/dashboard-data?client_id=2", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.match(json.error, /Forbidden/i);
    });

    test("1.2 Tenant A Bearer token attempting to access Tenant B dashboard returns 403 Forbidden", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const bearerA = await createBearerAuthHeader(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/portal/dashboard-data?client_id=2", {
        headers: { Authorization: bearerA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });

    test("1.3 Tenant A attempting to access Tenant B debtors via ?client_id=2 returns 403 Forbidden", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/portal/debtors?client_id=2", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });

    test("1.4 Tenant A searching debtor ledger for Tenant B debtor or invoice gets 0 results", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);

      // Search by Tenant B debtor name
      const req1 = new Request("http://localhost/api/portal/debtors?search=Beta", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res1 = await worker.fetch(req1, env);
      assert.strictEqual(res1.status, 200);
      const json1 = await res1.json() as any;
      assert.strictEqual(json1.debtors.length, 0);

      // Search by Tenant B invoice number
      const req2 = new Request("http://localhost/api/portal/debtors?search=INV-BETA-01", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res2 = await worker.fetch(req2, env);
      assert.strictEqual(res2.status, 200);
      const json2 = await res2.json() as any;
      assert.strictEqual(json2.debtors.length, 0);

      // Search by Tenant B debtor email domain
      const req3 = new Request("http://localhost/api/portal/debtors?search=beta.com", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res3 = await worker.fetch(req3, env);
      assert.strictEqual(res3.status, 200);
      const json3 = await res3.json() as any;
      assert.strictEqual(json3.debtors.length, 0);
    });

    test("1.5 Tenant A review queue GET /api/admin/drafts only returns Tenant A drafts", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/admin/drafts", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 200);
      const json = await res.json() as any;
      assert.strictEqual(json.drafts.length, 1);
      assert.strictEqual(json.drafts[0].id, 100);
      assert.strictEqual(json.drafts[0].client_id, 1);
      assert.strictEqual(json.drafts[0].invoice_number, "INV-ALPHA-01");
    });

    test("1.6 Tenant A passing ?client_id=2 to GET /api/admin/drafts does NOT leak Tenant B drafts", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/admin/drafts?client_id=2", {
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      // Even if endpoint returns 200, it MUST NOT return Tenant B drafts
      if (res.status === 200) {
        const json = await res.json() as any;
        for (const draft of json.drafts) {
          assert.strictEqual(draft.client_id, 1, "Tenant A must never see Tenant B draft in queue");
        }
      } else {
        assert.strictEqual(res.status, 403);
      }
    });

    test("1.7 Tenant A cannot approve Tenant B draft (returns 403, 0 emails, status unchanged)", async () => {
      const { env, db, send } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      // Draft 200 belongs to Tenant 2
      const req = new Request("http://localhost/api/admin/drafts/200/approve", {
        method: "POST",
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(send.sent.length, 0);

      const draftInDb = await db.prepare("SELECT status FROM chase_log WHERE id = 200").first<any>();
      assert.strictEqual(draftInDb.status, "draft");
    });

    test("1.8 Tenant A cannot approve Tenant B draft via legacy alias /api/chase/:id/approve", async () => {
      const { env, db, send } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/chase/200/approve", {
        method: "POST",
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(send.sent.length, 0);
    });

    test("1.9 Tenant A cannot skip Tenant B draft (returns 403, status unchanged)", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/admin/drafts/200/skip", {
        method: "POST",
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);

      const draftInDb = await db.prepare("SELECT status FROM chase_log WHERE id = 200").first<any>();
      assert.strictEqual(draftInDb.status, "draft");
    });

    test("1.10 Tenant A cannot skip Tenant B draft via legacy alias /api/chase/:id/skip", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/chase/200/skip", {
        method: "POST",
        headers: { Cookie: cookieA, Accept: "application/json" },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });

    test("1.11 Tenant A cannot edit Tenant B draft (returns 403, body unchanged)", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/admin/drafts/200", {
        method: "PUT",
        headers: {
          Cookie: cookieA,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "Malicious cross-tenant override attempt" }),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);

      const draftInDb = await db.prepare("SELECT body FROM chase_log WHERE id = 200").first<any>();
      assert.strictEqual(draftInDb.body, "Dear Beta Debtor 1, second notice.");
    });

    test("1.12 Tenant A cannot edit Tenant B draft via legacy alias /api/chase/:id", async () => {
      const { env, db } = createTestEnv();
      await seedMultiTenantData(db);

      const cookieA = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const req = new Request("http://localhost/api/chase/200", {
        method: "PUT",
        headers: {
          Cookie: cookieA,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: "Tampering via alias" }),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 403);
    });
  });

  // =========================================================================
  // SUITE 2: Approval Idempotency, Double-Send Prevention & Concurrency Stress
  // =========================================================================
  describe("2. Approval Idempotency, Double-Send Prevention & Concurrency", () => {
    async function seedDraftForApproval(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Vanguard Services', 'ops@vanguard.co.uk');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (10, 1, 'Target Debtor Ltd', 'billing@targetdebtor.co.uk', 'INV-VANG-10', 350000, date('now', '-12 days'));
        INSERT INTO chase_log (id, invoice_id, step, channel, status, subject, body, sent_at)
        VALUES (500, 10, 2, 'email', 'draft', 'OVERDUE: Invoice INV-VANG-10', 'Your account is overdue.', '2026-09-14 09:00:00');
      `);
    }

    test("2.1 Sequential double-approval returns 404 on second call and dispatches strictly 1 email", async () => {
      const { env, db, send } = createTestEnv();
      await seedDraftForApproval(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);

      // 1st approval
      const req1 = new Request("http://localhost/api/admin/drafts/500/approve", {
        method: "POST",
        headers: { Cookie: cookie, Accept: "application/json" },
      });
      const res1 = await worker.fetch(req1, env);
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(send.sent.length, 1);

      // Verify DB status transitioned to 'sent'
      const row1 = await db.prepare("SELECT status, outcome, reviewed_by FROM chase_log WHERE id = 500").first<any>();
      assert.strictEqual(row1.status, "sent");
      assert.strictEqual(row1.outcome, "sent");
      assert.strictEqual(row1.reviewed_by, "Tibor Rames");

      // 2nd approval (duplicate call)
      const req2 = new Request("http://localhost/api/admin/drafts/500/approve", {
        method: "POST",
        headers: { Cookie: cookie, Accept: "application/json" },
      });
      const res2 = await worker.fetch(req2, env);
      assert.strictEqual(res2.status, 404, "Subsequent approval on already sent draft must return 404");
      assert.strictEqual(send.sent.length, 1, "STRICT: Zero duplicate emails dispatched");

      // 3rd approval via legacy alias /api/chase/500/approve
      const req3 = new Request("http://localhost/api/chase/500/approve", {
        method: "POST",
        headers: { Cookie: cookie, Accept: "application/json" },
      });
      const res3 = await worker.fetch(req3, env);
      assert.strictEqual(res3.status, 404);
      assert.strictEqual(send.sent.length, 1, "STRICT: Zero duplicate emails dispatched via alias");
    });

    test("2.2 Approving non-existent draft ID returns 404 and 0 emails dispatched", async () => {
      const { env, send } = createTestEnv();
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/999999/approve", {
          method: "POST",
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
          },
        }),
        env,
      );
      assert.strictEqual(res.status, 404);
      assert.strictEqual(send.sent.length, 0);
    });

    test("2.3 Approving invalid draft IDs (-1, 0) returns 400 Bad Request and 0 emails dispatched", async () => {
      const { env, send } = createTestEnv();
      const resNegative = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/-1/approve", {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      // Route regex ^/api/(?:admin/drafts|chase)/(\d+)/approve$ only matches digits, so -1 returns 404
      assert.ok(resNegative.status === 400 || resNegative.status === 404);
      assert.strictEqual(send.sent.length, 0);

      const resZero = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/0/approve", {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(resZero.status, 400);
      assert.strictEqual(send.sent.length, 0);
    });

    test("2.4 Approving draft when debtor email is missing returns 422 Unprocessable Entity and 0 emails", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Client No Email', 'ops@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (20, 1, 'Ghost Debtor', NULL, 'INV-GHOST-1', 150000, date('now', '-3 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (550, 20, 1, 'draft', 'No email target');
      `);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/550/approve", {
          method: "POST",
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res.status, 422);
      assert.strictEqual(send.sent.length, 0);

      // Verify draft status remains 'draft'
      const row = await db.prepare("SELECT status FROM chase_log WHERE id = 550").first<any>();
      assert.strictEqual(row.status, "draft");
    });

    test("2.5 Concurrency Stress: 5 simultaneous approvals against same draft", async () => {
      const { env, db, send } = createTestEnv();
      await seedDraftForApproval(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);

      // Fire 5 concurrent requests simultaneously
      const promises = Array.from({ length: 5 }, () =>
        worker.fetch(
          new Request("http://localhost/api/admin/drafts/500/approve", {
            method: "POST",
            headers: { Cookie: cookie, Accept: "application/json" },
          }),
          env,
        ),
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map((r) => r.status);

      // Exactly at least 1 must succeed (200)
      const successCount = statuses.filter((s) => s === 200).length;
      assert.ok(successCount >= 1, "At least one request must succeed");

      // Verify final DB state is 'sent'
      const row = await db.prepare("SELECT status, outcome FROM chase_log WHERE id = 500").first<any>();
      assert.strictEqual(row.status, "sent");
      assert.strictEqual(row.outcome, "sent");

      // Check how many emails were dispatched:
      assert.strictEqual(send.sent.length, 1, `Expected exactly 1 email sent, got ${send.sent.length}`);
    });
  });

  // =========================================================================
  // SUITE 3: Skip Idempotency & Non-Interference
  // =========================================================================
  describe("3. Skip Idempotency & Non-Interference", () => {
    async function seedDraftForSkip(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Skip Test Client', 'skip@client.co.uk');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (30, 1, 'Skip Debtor Ltd', 'INV-SKIP-30', 220000, date('now', '-7 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body)
        VALUES (600, 30, 1, 'draft', 'Draft awaiting skip');
      `);
    }

    test("3.1 First skip marks draft as 'skipped', stamps reviewed_at and dispatches 0 emails", async () => {
      const { env, db, send, notify } = createTestEnv();
      await seedDraftForSkip(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/600/skip", {
          method: "POST",
          headers: { Cookie: cookie, Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res.status, 200);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.status, "skipped");

      assert.strictEqual(send.sent.length, 0);
      assert.strictEqual(notify.sent.length, 0);

      const row = await db.prepare("SELECT status, reviewed_at, reviewed_by FROM chase_log WHERE id = 600").first<any>();
      assert.strictEqual(row.status, "skipped");
      assert.ok(row.reviewed_at !== null);
      assert.strictEqual(row.reviewed_by, "Tibor Rames");
    });

    test("3.2 Repeated skip on already skipped draft is idempotent (returns 200, 0 emails)", async () => {
      const { env, db, send, notify } = createTestEnv();
      await seedDraftForSkip(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);

      // First skip
      await worker.fetch(
        new Request("http://localhost/api/admin/drafts/600/skip", {
          method: "POST",
          headers: { Cookie: cookie, Accept: "application/json" },
        }),
        env,
      );

      // Second skip
      const res2 = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/600/skip", {
          method: "POST",
          headers: { Cookie: cookie, Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res2.status, 200);
      const json2 = await res2.json() as any;
      assert.strictEqual(json2.ok, true);
      assert.strictEqual(json2.status, "skipped");

      // Third skip via legacy alias
      const res3 = await worker.fetch(
        new Request("http://localhost/api/chase/600/skip", {
          method: "POST",
          headers: { Cookie: cookie, Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res3.status, 200);

      assert.strictEqual(send.sent.length, 0);
      assert.strictEqual(notify.sent.length, 0);
    });

    test("3.3 Skipping an already SENT draft does NOT overwrite DB status to 'skipped'", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (40, 1, 'Debtor 40', 'INV-40', 100000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, outcome) VALUES (700, 40, 1, 'sent', 'sent');
      `);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      await worker.fetch(
        new Request("http://localhost/api/admin/drafts/700/skip", {
          method: "POST",
          headers: { Cookie: cookie, Accept: "application/json" },
        }),
        env,
      );

      // Critical DB check: the record MUST retain status = 'sent'
      const row = await db.prepare("SELECT status, outcome FROM chase_log WHERE id = 700").first<any>();
      assert.strictEqual(row.status, "sent", "Sent draft must NOT have its status overwritten in DB by skip");
      assert.strictEqual(send.sent.length, 0);
    });

    test("3.4 Skipping non-existent draft ID returns 404", async () => {
      const { env } = createTestEnv();
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/999999/skip", {
          method: "POST",
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
          },
        }),
        env,
      );
      assert.strictEqual(res.status, 404);
    });
  });

  // =========================================================================
  // SUITE 4: Draft Update Validation & In-Place Editing
  // =========================================================================
  describe("4. Draft Update Validation & In-Place Editing", () => {
    async function seedDraftForUpdate(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Update Client', 'up@client.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (50, 1, 'Update Debtor', 'INV-UP-50', 180000, date('now', '-6 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (800, 50, 1, 'draft', 'Original Subject Line', 'Original Draft Body Text');
      `);
    }

    test("4.1 In-place update with valid body and subject saves to DB while preserving 'draft' status", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: {
            Cookie: cookie,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            body: "Revised message: Please settle invoice INV-UP-50 today.",
            subject: "REVISED: Urgent Settlement Request",
          }),
        }),
        env,
      );
      assert.strictEqual(res.status, 200);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.body, "Revised message: Please settle invoice INV-UP-50 today.");
      assert.strictEqual(json.subject, "REVISED: Urgent Settlement Request");

      const row = await db.prepare("SELECT body, subject, status FROM chase_log WHERE id = 800").first<any>();
      assert.strictEqual(row.body, "Revised message: Please settle invoice INV-UP-50 today.");
      assert.strictEqual(row.subject, "REVISED: Urgent Settlement Request");
      assert.strictEqual(row.status, "draft", "Status must remain 'draft'");
    });

    test("4.2 In-place update rejects empty body string '' with 400 Bad Request", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: "" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 400);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.match(json.error, /Draft body cannot be empty/i);

      // DB body must remain original
      const row = await db.prepare("SELECT body FROM chase_log WHERE id = 800").first<any>();
      assert.strictEqual(row.body, "Original Draft Body Text");
    });

    test("4.3 In-place update rejects whitespace-only body with 400 Bad Request", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: "   \n\t  \r\n  " }),
        }),
        env,
      );
      assert.strictEqual(res.status, 400);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.match(json.error, /Draft body cannot be empty/i);
    });

    test("4.4 In-place update rejects missing body property with 400 Bad Request", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ subject: "Only changing subject without body" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 400);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
    });

    test("4.5 In-place update rejects malformed JSON with 400 Bad Request", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: '{"body": "unterminated string',
        }),
        env,
      );
      assert.strictEqual(res.status, 400);
      const json = await res.json() as any;
      assert.strictEqual(json.ok, false);
      assert.match(json.error, /Invalid JSON/i);
    });

    test("4.6 In-place update rejects editing an already SENT draft with 404", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);
      await db.rawSqlite.exec("UPDATE chase_log SET status = 'sent' WHERE id = 800");

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: "Trying to edit sent message" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 404);
      const json = await res.json() as any;
      assert.match(json.error, /already reviewed/i);
    });

    test("4.7 In-place update rejects editing an already SKIPPED draft with 404", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);
      await db.rawSqlite.exec("UPDATE chase_log SET status = 'skipped' WHERE id = 800");

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: "Trying to edit skipped message" }),
        }),
        env,
      );
      assert.strictEqual(res.status, 404);
    });

    test("4.8 In-place update preserves large statutory notice bodies (15KB) and Unicode/symbols", async () => {
      const { env, db } = createTestEnv();
      await seedDraftForUpdate(db);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);
      const complexBody = "UK Late Payment Act Notice: £4,500.00 + £70.00 fee + £12.50 interest = £4,582.50. ⚡ ⚠️ " +
        "Detailed legal notice: ".repeat(300);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/800", {
          method: "PUT",
          headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ body: complexBody }),
        }),
        env,
      );
      assert.strictEqual(res.status, 200);

      const row = await db.prepare("SELECT body FROM chase_log WHERE id = 800").first<any>();
      assert.strictEqual(row.body, complexBody);
    });
  });

  // =========================================================================
  // SUITE 5: Outbound Email Integrity & Sign-Off Constraints
  // =========================================================================
  describe("5. Outbound Email Integrity & Sign-Off Constraints", () => {
    test("5.1 Outbound email strictly enforces locked sender 'hello@invoicerescue.co.uk', display name, and debtor recipient", async () => {
      const { env, db, send, notify } = createTestEnv({
        NOTIFY_FROM: "hello@invoicerescue.co.uk",
        OPERATOR_NAME: "Tibor Rames",
      });

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Acme Solutions', 'contact@acme.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (101, 1, 'Debtor Firm Ltd', 'accounts.payable@debtorfirm.co.uk', 'INV-ACME-99', 850000, date('now', '-18 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (901, 101, 3, 'draft', 'Stage 3 Notice — INV-ACME-99', 'Please settle immediately.\n\nTibor Rames\nInvoice Rescue on behalf of Acme Solutions');
      `);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/901/approve", {
          method: "POST",
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
          },
        }),
        env,
      );
      assert.strictEqual(res.status, 200);

      // Verify email delivery via SEND binding
      assert.strictEqual(send.sent.length, 1);
      const email = send.sent[0];

      // 1. Recipient must match debtor_email
      assert.strictEqual(email.to, "accounts.payable@debtorfirm.co.uk");

      // 2. Sender must be locked to hello@invoicerescue.co.uk
      assert.strictEqual(email.from.email, "hello@invoicerescue.co.uk");

      // 3. Display name must be "Invoice Rescue"
      assert.strictEqual(email.from.name, "Invoice Rescue");

      // 4. Body must contain Tibor Rames sign-off
      assert.ok(email.text?.includes("Tibor Rames"), "Outbound email must contain Tibor Rames sign-off");

      // 5. Split-trust check: Operator inbox NOTIFY receives zero debtor emails
      assert.strictEqual(notify.sent.length, 0);

      // 6. Database audit check: reviewed_by is recorded as Tibor Rames
      const audit = await db.prepare("SELECT reviewed_by, status, outcome FROM chase_log WHERE id = 901").first<any>();
      assert.strictEqual(audit.reviewed_by, "Tibor Rames");
      assert.strictEqual(audit.status, "sent");
      assert.strictEqual(audit.outcome, "sent");
    });

    test("5.2 Custom edited message body provided during POST /approve is dispatched to debtor verbatim", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Acme Solutions', 'contact@acme.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (102, 1, 'Client ABC', 'abc@debtor.com', 'INV-ACME-102', 200000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, subject, body)
        VALUES (902, 102, 1, 'draft', 'Reminder', 'Standard unedited text');
      `);

      const customMessage = "Custom text approved by operator:\n\nPlease contact us.\n\nTibor Rames\nInvoice Rescue";

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/902/approve", {
          method: "POST",
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: customMessage }),
        }),
        env,
      );
      assert.strictEqual(res.status, 200);

      assert.strictEqual(send.sent.length, 1);
      assert.strictEqual(send.sent[0].text, customMessage);

      // DB must also store the updated custom message
      const row = await db.prepare("SELECT body FROM chase_log WHERE id = 902").first<any>();
      assert.strictEqual(row.body, customMessage);
    });
  });

  // =========================================================================
  // SUITE 6: Draft Queue Statutory Claim Calculations & Fee Tiers
  // =========================================================================
  describe("6. Draft Queue Statutory Claim Calculations & Fee Tiers", () => {
    test("6.1 GET /api/admin/drafts returns exact statutory calculations across all fee tiers (£40, £70, £100)", async () => {
      const { env, db } = createTestEnv({ BOE_BASE_RATE_PERCENT: "3.75" });
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Statutory Test Co', 'stat@test.co.uk');

        -- Invoice 1: £850.00 (< £1,000) -> Fee £40 (4,000p), 5 days overdue
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor Small', 'INV-STAT-1', 85000, date('now', '-5 days'));

        -- Invoice 2: £4,500.00 (£1,000 to £9,999.99) -> Fee £70 (7,000p), 12 days overdue
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (2, 1, 'Debtor Medium', 'INV-STAT-2', 450000, date('now', '-12 days'));

        -- Invoice 3: £15,000.00 (>= £10,000) -> Fee £100 (10,000p), 25 days overdue
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (3, 1, 'Debtor Large', 'INV-STAT-3', 1500000, date('now', '-25 days'));

        INSERT INTO chase_log (id, invoice_id, step, status, sent_at)
        VALUES (1001, 1, 1, 'draft', '2026-09-10'),
               (1002, 2, 2, 'draft', '2026-09-11'),
               (1003, 3, 4, 'draft', '2026-09-12');
      `);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts", {
          headers: { Authorization: createBasicAuthHeader(env.ADMIN_SECRET), Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res.status, 200);
      const json = await res.json() as any;
      assert.strictEqual(json.drafts.length, 3);

      // Draft 1 (< £1,000)
      const d1 = json.drafts.find((d: any) => d.id === 1001);
      assert.strictEqual(d1.principal_pence, 85000);
      assert.strictEqual(d1.fixed_compensation_pence, 4000);
      // Interest: (85,000 * 11.75 / 100 / 365) * 5 = Math.round(136.815...) = 137
      assert.strictEqual(d1.statutory_interest_pence, 137);
      assert.strictEqual(d1.total_claim_pence, 85000 + 4000 + 137);

      // Draft 2 (£1,000 to £9,999.99)
      const d2 = json.drafts.find((d: any) => d.id === 1002);
      assert.strictEqual(d2.principal_pence, 450000);
      assert.strictEqual(d2.fixed_compensation_pence, 7000);
      // Interest: (450,000 * 11.75 / 100 / 365) * 12 = Math.round(1738.356...) = 1738
      assert.strictEqual(d2.statutory_interest_pence, 1738);
      assert.strictEqual(d2.total_claim_pence, 450000 + 7000 + 1738);

      // Draft 3 (>= £10,000)
      const d3 = json.drafts.find((d: any) => d.id === 1003);
      assert.strictEqual(d3.principal_pence, 1500000);
      assert.strictEqual(d3.fixed_compensation_pence, 10000);
      // Interest: (1,500,000 * 11.75 / 100 / 365) * 25 = Math.round(12071.917...) = 12072
      assert.strictEqual(d3.statutory_interest_pence, 12072);
      assert.strictEqual(d3.total_claim_pence, 1500000 + 10000 + 12072);
    });
  });

  // =========================================================================
  // SUITE 7: Authentication & Route Security
  // =========================================================================
  describe("7. Authentication & Route Security", () => {
    test("7.1 Unauthenticated requests to approve, skip, or edit drafts return 401 Unauthorized", async () => {
      const { env } = createTestEnv();

      const resApprove = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/100/approve", { method: "POST" }),
        env,
      );
      assert.strictEqual(resApprove.status, 401);

      const resSkip = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/100/skip", { method: "POST" }),
        env,
      );
      assert.strictEqual(resSkip.status, 401);

      const resEdit = await worker.fetch(
        new Request("http://localhost/api/admin/drafts/100", { method: "PUT" }),
        env,
      );
      assert.strictEqual(resEdit.status, 401);
    });

    test("7.2 Invalid Basic Auth credentials return 401 Unauthorized", async () => {
      const { env } = createTestEnv();
      const invalidBasic = `Basic ${btoa("admin:wrong-password-999")}`;

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts", {
          headers: { Authorization: invalidBasic, Accept: "application/json" },
        }),
        env,
      );
      assert.strictEqual(res.status, 401);
    });

    test("7.3 HTML form submission redirects 303 to /admin when Accept does not include application/json", async () => {
      const { env, db, send } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'C1', 'c1@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Debtor 1', 'deb@test.com', 'INV-1', 50000, date('now', '-5 days'));
        INSERT INTO chase_log (id, invoice_id, step, status, body) VALUES (1100, 1, 1, 'draft', 'Draft body');
      `);

      const req = new Request("http://localhost/api/admin/drafts/1100/approve", {
        method: "POST",
        headers: {
          Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
          Accept: "text/html,application/xhtml+xml",
        },
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 303);
      assert.strictEqual(res.headers.get("Location"), "/admin");
      assert.strictEqual(send.sent.length, 1);
    });
  });

  // =========================================================================
  // SUITE 8: Adversarial SQL Injection & Malicious Parameter Probing
  // =========================================================================
  describe("8. Adversarial SQL Injection & Malicious Parameter Probing", () => {
    test("8.1 SQL injection payloads in debtor search, sort, stage, and status do not leak data or error out", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Safe Corp', 'safe@corp.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES (1, 1, 'Legit Debtor', 'INV-LEGIT', 100000, date('now', '-5 days'));
      `);

      const cookie = await createSessionCookie(1, env.PORTAL_SESSION_SECRET);

      const maliciousQueries = [
        "search=' OR '1'='1",
        "search='; DROP TABLE invoices; --",
        "sort='; DROP TABLE clients; --",
        "dir=ASC; DROP TABLE chase_log; --",
        "stage=1' OR '1'='1",
        "status=overdue' OR '1'='1",
      ];

      for (const q of maliciousQueries) {
        const res = await worker.fetch(
          new Request(`http://localhost/api/portal/debtors?${q}`, {
            headers: { Cookie: cookie, Accept: "application/json" },
          }),
          env,
        );
        assert.strictEqual(res.status, 200, `Query ${q} should return 200 and not crash`);
        const json = await res.json() as any;
        assert.strictEqual(json.ok, true);
      }

      // Verify table was NOT dropped
      const count = await db.prepare("SELECT count(*) as cnt FROM invoices").first<any>();
      assert.strictEqual(count.cnt, 1);
    });

    test("8.2 Malicious client_id query param values do not cause uncaught 500 crashes", async () => {
      const { env, db } = createTestEnv();
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, status, contact_email) VALUES (1, 'C1', 'active', 'c1@test.com');
      `);

      const maliciousParams = [
        "?client_id=NaN",
        "?client_id=undefined",
        "?client_id=-1",
        "?client_id=' OR 1=1 --",
        "?client_id=[object%20Object]",
      ];

      for (const param of maliciousParams) {
        const res = await worker.fetch(
          new Request(`http://localhost/api/portal/dashboard-data${param}`, {
            headers: { Accept: "application/json" },
          }),
          env,
        );
        // Should handle safely without uncaught server crash (status 200 fallback or 400/403)
        assert.ok(res.status === 200 || res.status === 400 || res.status === 403);
      }
    });
  });
});
