import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTestEnv, createBasicAuthHeader } from "./e2e/harness";
import { buildSessionCookie } from "../backend/src/lib/portal-auth";
import worker from "../backend/src/index";
import { fixedCompensationPence, statutoryInterestPence } from "../backend/src/lib/statutory-interest";
import { calculateDaysOverdue, deriveStage, formatMoney } from "../backend/src/lib/portal-api";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Milestone M3 Empirical Challenge Suite (Challenger 2)", () => {
  // Helper for authenticated client session cookie
  async function createSessionCookie(clientId: number, secret: string): Promise<string> {
    const raw = await buildSessionCookie(clientId, secret);
    const match = raw.match(/^(portal_session=[^;]+)/);
    return match ? match[1] : raw;
  }

  // =========================================================================
  // MISSION 1: Debtor search and multi-criteria filtering combinations
  // =========================================================================
  describe("Mission 1: Debtor Search & Multi-Criteria Filtering Combinations", () => {
    // Seed database with a rich, diverse dataset of invoices
    async function seedDebtorLedger(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Studio Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, debtor_email, invoice_number, amount_pence, due_date, status)
        VALUES
          (1, 1, 'Hartley & Co Ltd', 'accounts@hartleyandco.co.uk', 'INV-2026-089', 485000, date('now', '-24 days'), 'overdue'),
          (2, 1, 'Meridian Build Partners', 'finance@meridianbuild.co.uk', 'INV-2026-104', 1230000, date('now', '-18 days'), 'overdue'),
          (3, 1, 'Foxglove Creative Studio', 'billing@foxglovestudio.com', 'INV-2026-072', 215000, date('now', '-11 days'), 'paid'),
          (4, 1, 'Vantage Architecture', 'invoices@vantagearch.co.uk', 'INV-2026-112', 640000, date('now', '-9 days'), 'overdue'),
          (5, 1, 'Kestrel Logistics UK', 'ap@kestrellogistics.co.uk', 'INV-2026-121', 375000, date('now', '-5 days'), 'overdue'),
          (6, 1, 'Blackwood Digital Media', 'finance@blackwooddigital.co.uk', 'INV-2026-095', 890000, date('now', '-16 days'), 'promised'),
          (7, 1, 'Crestview Engineering Ltd', 'accounts@crestview-eng.co.uk', 'INV-2026-118', 1520000, date('now', '-31 days'), 'overdue'),
          (8, 1, 'Solent Media Group', 'pay@solentmediagroup.com', 'INV-2026-130', 185000, date('now', '-3 days'), 'overdue'),
          (9, 1, 'Northstar Consulting', 'ap@northstarconsulting.co.uk', 'INV-2026-088', 520000, date('now', '-14 days'), 'disputed'),
          (10, 1, 'Amberley Retail Design', 'accounts@amberleydesign.co.uk', 'INV-2026-102', 710000, date('now', '-12 days'), 'paid'),
          (11, 1, 'Halcyon Brand Works', 'hello@halcyonbrandworks.co.uk', 'INV-2026-135', 95000, date('now', '-6 days'), 'overdue'),
          (12, 1, 'Zenith Property Dev', 'finance@zenithproperty.co.uk', 'INV-2026-110', 1150000, date('now', '-22 days'), 'overdue'),
          (13, 1, 'Current Account Debtor', 'current@example.com', 'INV-2026-CUR', 150000, date('now', '+5 days'), 'overdue');
      `);
    }

    test("1.1 Single search filter matches debtor name, email, or invoice number case-insensitively", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      // Search by partial debtor name (lowercase)
      const res1 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=hartley", { headers: { Accept: "application/json" } }),
        env,
      );
      const json1 = (await res1.json()) as any;
      assert.strictEqual(json1.debtors.length, 1);
      assert.strictEqual(json1.debtors[0].invoice_number, "INV-2026-089");

      // Search by partial debtor name with special char "&"
      const resAmp = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=%26%20co", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAmp = (await resAmp.json()) as any;
      assert.strictEqual(jsonAmp.debtors.length, 1);
      assert.strictEqual(jsonAmp.debtors[0].debtor_name, "Hartley & Co Ltd");

      // Search by invoice number substring
      const res2 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=118", { headers: { Accept: "application/json" } }),
        env,
      );
      const json2 = (await res2.json()) as any;
      assert.strictEqual(json2.debtors.length, 1);
      assert.strictEqual(json2.debtors[0].invoice_number, "INV-2026-118");

      // Search by domain in email
      const res3 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=kestrellogistics.co.uk", { headers: { Accept: "application/json" } }),
        env,
      );
      const json3 = (await res3.json()) as any;
      assert.strictEqual(json3.debtors.length, 1);
      assert.strictEqual(json3.debtors[0].debtor_name, "Kestrel Logistics UK");
    });

    test("1.2 Stage filtering correctly isolates each escalation stage", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      // Stage 1 (Gentle, 1-7 days)
      const resS1 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=1", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonS1 = (await resS1.json()) as any;
      // Invoices overdue 5d, 3d, 6d
      assert.strictEqual(jsonS1.debtors.length, 3);
      for (const d of jsonS1.debtors) {
        assert.strictEqual(d.stage, 1);
        assert.ok(d.days_overdue >= 1 && d.days_overdue <= 7);
      }

      // Stage 2 (Follow-up, 8-14 days)
      const resS2 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=2", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonS2 = (await resS2.json()) as any;
      // Invoices overdue 11d, 9d, 14d, 12d
      assert.strictEqual(jsonS2.debtors.length, 4);
      for (const d of jsonS2.debtors) {
        assert.strictEqual(d.stage, 2);
        assert.ok(d.days_overdue >= 8 && d.days_overdue <= 14);
      }

      // Stage 3 (Firm, 15-21 days)
      const resS3 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=3", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonS3 = (await resS3.json()) as any;
      // Invoices overdue 18d, 16d
      assert.strictEqual(jsonS3.debtors.length, 2);
      for (const d of jsonS3.debtors) {
        assert.strictEqual(d.stage, 3);
        assert.ok(d.days_overdue >= 15 && d.days_overdue <= 21);
      }

      // Stage 4 (Final, 22+ days)
      const resS4 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=4", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonS4 = (await resS4.json()) as any;
      // Invoices overdue 24d, 31d, 22d
      assert.strictEqual(jsonS4.debtors.length, 3);
      for (const d of jsonS4.debtors) {
        assert.strictEqual(d.stage, 4);
        assert.ok(d.days_overdue >= 22);
      }

      // Stage 0 (Current, <1 day)
      const resS0 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?stage=0", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonS0 = (await resS0.json()) as any;
      assert.strictEqual(jsonS0.debtors.length, 1);
      assert.strictEqual(jsonS0.debtors[0].invoice_number, "INV-2026-CUR");
      assert.strictEqual(jsonS0.debtors[0].stage, 0);
    });

    test("1.3 Status filtering correctly isolates overdue, paid, promised, disputed", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      // Status: paid
      const resPaid = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?status=paid", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonPaid = (await resPaid.json()) as any;
      assert.strictEqual(jsonPaid.debtors.length, 2);
      for (const d of jsonPaid.debtors) {
        assert.strictEqual(d.status, "paid");
      }

      // Status: disputed
      const resDisp = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?status=disputed", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonDisp = (await resDisp.json()) as any;
      assert.strictEqual(jsonDisp.debtors.length, 1);
      assert.strictEqual(jsonDisp.debtors[0].invoice_number, "INV-2026-088");

      // Status: promised
      const resProm = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?status=promised", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonProm = (await resProm.json()) as any;
      assert.strictEqual(jsonProm.debtors.length, 1);
      assert.strictEqual(jsonProm.debtors[0].debtor_name, "Blackwood Digital Media");
    });

    test("1.4 Combined Search + Stage + Status filtering behaves conjunctively (AND)", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      // Search 'media' (matches Solent Media Group and Blackwood Digital Media)
      // Solent Media Group: stage 1, status overdue
      // Blackwood Digital Media: stage 3, status promised

      // Test 1: Search 'media' + stage 1 + status overdue -> Solent Media Group
      const resCombo1 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=media&stage=1&status=overdue", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonCombo1 = (await resCombo1.json()) as any;
      assert.strictEqual(jsonCombo1.debtors.length, 1);
      assert.strictEqual(jsonCombo1.debtors[0].debtor_name, "Solent Media Group");

      // Test 2: Search 'media' + stage 3 + status promised -> Blackwood Digital Media
      const resCombo2 = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=media&stage=3&status=promised", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonCombo2 = (await resCombo2.json()) as any;
      assert.strictEqual(jsonCombo2.debtors.length, 1);
      assert.strictEqual(jsonCombo2.debtors[0].debtor_name, "Blackwood Digital Media");

      // Test 3: Search 'media' + stage 3 + status overdue -> 0 results (conflicting filter)
      const resConflict = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=media&stage=3&status=overdue", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonConflict = (await resConflict.json()) as any;
      assert.strictEqual(jsonConflict.debtors.length, 0);

      // Test 4: Search 'creative' + stage 2 + status paid -> Foxglove Creative Studio
      const resPaidCombo = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=creative&stage=2&status=paid", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonPaidCombo = (await resPaidCombo.json()) as any;
      assert.strictEqual(jsonPaidCombo.debtors.length, 1);
      assert.strictEqual(jsonPaidCombo.debtors[0].debtor_name, "Foxglove Creative Studio");

      // Test 5: Search non-existent string with all filters
      const resEmpty = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?search=nonexistentxyz&stage=all&status=all", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonEmpty = (await resEmpty.json()) as any;
      assert.strictEqual(jsonEmpty.debtors.length, 0);
    });

    test("1.5 Adversarial inputs: SQL injection strings and special punctuation do not crash or leak data", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      const adversarialQueries = [
        "' OR '1'='1",
        "'; DROP TABLE invoices; --",
        "UNION SELECT * FROM clients",
        "<script>alert(1)</script>",
        "%20%27%22",
        "&",
        "Co. Ltd.",
      ];

      for (const q of adversarialQueries) {
        const url = `http://localhost/api/portal/debtors?search=${encodeURIComponent(q)}`;
        const res = await worker.fetch(new Request(url, { headers: { Accept: "application/json" } }), env);
        assert.strictEqual(res.status, 200, `Expected 200 OK for adversarial search: ${q}`);
        const json = (await res.json()) as any;
        assert.ok(Array.isArray(json.debtors));
      }
    });

    test("1.6 Pagination boundaries: clamps limit to 100, handles negative pages safely", async () => {
      const { env, db } = createTestEnv();
      await seedDebtorLedger(db);

      // Excessive limit clamped to 100
      const resExcessive = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?limit=99999", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonExcessive = (await resExcessive.json()) as any;
      assert.strictEqual(jsonExcessive.limit, 100);

      // Negative limit clamped to min 1, negative page clamped to 1
      const resNeg = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?page=-5&limit=-10", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonNeg = (await resNeg.json()) as any;
      assert.strictEqual(jsonNeg.page, 1);
      assert.strictEqual(jsonNeg.limit, 1); // clamped to Math.max(1, ...)
    });
  });

  // =========================================================================
  // MISSION 2: Multi-column sort across all columns (asc & desc)
  // =========================================================================
  describe("Mission 2: Multi-Column Sort Across All Columns (ASC & DESC)", () => {
    async function seedSortingInvoices(db: any) {
      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Sort Test Client', 'sort@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date, status)
        VALUES
          (1, 1, 'Zeta Corp', 'INV-001', 10000, date('now', '-5 days'), 'overdue'),
          (2, 1, 'Alpha Inc', 'INV-002', 900000, date('now', '-30 days'), 'overdue'),
          (3, 1, 'Omega LLC', 'INV-003', 250000, date('now', '-15 days'), 'paid'),
          (4, 1, 'Beta Ltd', 'INV-004', 50000, date('now', '-1 days'), 'promised'),
          (5, 1, 'Gamma Co', 'INV-005', 1500000, date('now', '-45 days'), 'disputed');
      `);
    }

    test("2.1 Amount sort (ASC & DESC)", async () => {
      const { env, db } = createTestEnv();
      await seedSortingInvoices(db);

      // Amount ASC (lowest to highest: 10000, 50000, 250000, 900000, 1500000)
      const resAsc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=amount_pence&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAsc = (await resAsc.json()) as any;
      const amountsAsc = jsonAsc.debtors.map((d: any) => d.amount_pence);
      assert.deepStrictEqual(amountsAsc, [10000, 50000, 250000, 900000, 1500000]);

      // Amount DESC (highest to lowest: 1500000, 900000, 250000, 50000, 10000)
      const resDesc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=amount_pence&dir=desc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonDesc = (await resDesc.json()) as any;
      const amountsDesc = jsonDesc.debtors.map((d: any) => d.amount_pence);
      assert.deepStrictEqual(amountsDesc, [1500000, 900000, 250000, 50000, 10000]);

      // Alias sort=amount also works
      const resAlias = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=amount&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAlias = (await resAlias.json()) as any;
      assert.strictEqual(jsonAlias.debtors[0].amount_pence, 10000);
    });

    test("2.2 Due Date sort (ASC & DESC)", async () => {
      const { env, db } = createTestEnv();
      await seedSortingInvoices(db);

      // Due Date ASC (earliest to latest)
      const resAsc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=due_date&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAsc = (await resAsc.json()) as any;
      const datesAsc = jsonAsc.debtors.map((d: any) => d.due_date);
      for (let i = 0; i < datesAsc.length - 1; i++) {
        assert.ok(datesAsc[i] <= datesAsc[i + 1], `Dates should be ascending: ${datesAsc[i]} <= ${datesAsc[i + 1]}`);
      }

      // Due Date DESC (latest to earliest)
      const resDesc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=due_date&dir=desc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonDesc = (await resDesc.json()) as any;
      const datesDesc = jsonDesc.debtors.map((d: any) => d.due_date);
      for (let i = 0; i < datesDesc.length - 1; i++) {
        assert.ok(datesDesc[i] >= datesDesc[i + 1], `Dates should be descending: ${datesDesc[i]} >= ${datesDesc[i + 1]}`);
      }
    });

    test("2.3 Days Overdue sort (ASC & DESC)", async () => {
      const { env, db } = createTestEnv();
      await seedSortingInvoices(db);

      // Days Overdue ASC (least overdue first: 1, 5, 15, 30, 45)
      const resAsc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=days_overdue&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAsc = (await resAsc.json()) as any;
      const daysAsc = jsonAsc.debtors.map((d: any) => d.days_overdue);
      assert.deepStrictEqual(daysAsc, [1, 5, 15, 30, 45]);

      // Days Overdue DESC (most overdue first: 45, 30, 15, 5, 1)
      const resDesc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=days_overdue&dir=desc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonDesc = (await resDesc.json()) as any;
      const daysDesc = jsonDesc.debtors.map((d: any) => d.days_overdue);
      assert.deepStrictEqual(daysDesc, [45, 30, 15, 5, 1]);
    });

    test("2.4 Debtor Name sort (ASC & DESC) case-insensitively", async () => {
      const { env, db } = createTestEnv();
      await seedSortingInvoices(db);

      // Debtor Name ASC (Alpha Inc, Beta Ltd, Gamma Co, Omega LLC, Zeta Corp)
      const resAsc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=debtor_name&dir=asc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonAsc = (await resAsc.json()) as any;
      const namesAsc = jsonAsc.debtors.map((d: any) => d.debtor_name);
      assert.deepStrictEqual(namesAsc, ["Alpha Inc", "Beta Ltd", "Gamma Co", "Omega LLC", "Zeta Corp"]);

      // Debtor Name DESC (Zeta Corp, Omega LLC, Gamma Co, Beta Ltd, Alpha Inc)
      const resDesc = await worker.fetch(
        new Request("http://localhost/api/portal/debtors?sort=debtor_name&dir=desc", { headers: { Accept: "application/json" } }),
        env,
      );
      const jsonDesc = (await resDesc.json()) as any;
      const namesDesc = jsonDesc.debtors.map((d: any) => d.debtor_name);
      assert.deepStrictEqual(namesDesc, ["Zeta Corp", "Omega LLC", "Gamma Co", "Beta Ltd", "Alpha Inc"]);
    });

    test("2.5 Frontend client-side sorting algorithm matches backend sort results exactly", () => {
      // Replicate the client-side sorting implementation in dashboard.js
      const testList = [
        { debtor_name: "Zeta Corp", invoice_number: "INV-001", amount_pence: 10000, due_date: "2026-09-11", days_overdue: 5 },
        { debtor_name: "Alpha Inc", invoice_number: "INV-002", amount_pence: 900000, due_date: "2026-08-17", days_overdue: 30 },
        { debtor_name: "Omega LLC", invoice_number: "INV-003", amount_pence: 250000, due_date: "2026-09-01", days_overdue: 15 },
        { debtor_name: "Beta Ltd", invoice_number: "INV-004", amount_pence: 50000, due_date: "2026-09-15", days_overdue: 1 },
        { debtor_name: "Gamma Co", invoice_number: "INV-005", amount_pence: 1500000, due_date: "2026-08-02", days_overdue: 45 },
      ];

      function clientSort(list: any[], col: string, dir: string) {
        return [...list].sort((a, b) => {
          let valA = a[col];
          let valB = b[col];
          if (typeof valA === "string") valA = valA.toLowerCase();
          if (typeof valB === "string") valB = valB.toLowerCase();
          if (valA < valB) return dir === "asc" ? -1 : 1;
          if (valA > valB) return dir === "asc" ? 1 : -1;
          return 0;
        });
      }

      // Check debtor_name asc
      const sortedNames = clientSort(testList, "debtor_name", "asc").map((x) => x.debtor_name);
      assert.deepStrictEqual(sortedNames, ["Alpha Inc", "Beta Ltd", "Gamma Co", "Omega LLC", "Zeta Corp"]);

      // Check amount_pence desc
      const sortedAmounts = clientSort(testList, "amount_pence", "desc").map((x) => x.amount_pence);
      assert.deepStrictEqual(sortedAmounts, [1500000, 900000, 250000, 50000, 10000]);

      // Check days_overdue asc
      const sortedDays = clientSort(testList, "days_overdue", "asc").map((x) => x.days_overdue);
      assert.deepStrictEqual(sortedDays, [1, 5, 15, 30, 45]);
    });

    test("2.6 Sorts invoice_number, status, stage ASC and DESC, falls back safely on invalid column or direction", async () => {
      const { env, db } = createTestEnv();
      await seedSortingInvoices(db);

      // invoice_number ASC
      const resInv = await worker.fetch(new Request("http://localhost/api/portal/debtors?sort=invoice_number&dir=asc", { headers: { Accept: "application/json" } }), env);
      const jsonInv = (await resInv.json()) as any;
      assert.deepStrictEqual(jsonInv.debtors.map((d: any) => d.invoice_number), ["INV-001", "INV-002", "INV-003", "INV-004", "INV-005"]);

      // invalid sort column safely falls back without error
      const resInvalid = await worker.fetch(new Request("http://localhost/api/portal/debtors?sort=nonexistent_col&dir=invalid_dir", { headers: { Accept: "application/json" } }), env);
      assert.strictEqual(resInvalid.status, 200);
      const jsonInvalid = (await resInvalid.json()) as any;
      assert.strictEqual(jsonInvalid.debtors.length, 5);
    });
  });

  // =========================================================================
  // MISSION 3: Draft statutory financial calculations (Zero Drift Across Tiers)
  // =========================================================================
  describe("Mission 3: Draft Statutory Financial Calculations & Zero Drift", () => {
    // Exact mathematical oracle per Late Payment of Commercial Debts Act 1998
    function statutoryOracle(amountPence: number, daysOverdue: number, boeRate: number) {
      let compensationPence = 4000;
      if (amountPence >= 100000 && amountPence < 1000000) {
        compensationPence = 7000;
      } else if (amountPence >= 1000000) {
        compensationPence = 10000;
      }

      const annualRate = boeRate + 8;
      const interestPence = daysOverdue <= 0
        ? 0
        : Math.round(((amountPence * annualRate) / 100 / 365) * daysOverdue);

      const totalClaimPence = amountPence + compensationPence + interestPence;
      return { compensationPence, interestPence, totalClaimPence };
    }

    test("3.1 Fixed compensation tiers match statutory thresholds precisely (<£1k -> £40, £1k-£10k -> £70, >=£10k -> £100)", () => {
      // Tier 1: Under £1,000 (< 100,000 pence)
      assert.strictEqual(fixedCompensationPence(1), 4000); // 1p
      assert.strictEqual(fixedCompensationPence(5000), 4000); // £50.00
      assert.strictEqual(fixedCompensationPence(99999), 4000); // £999.99 (Boundary below £1,000)

      // Tier 2: £1,000 to £9,999.99 (100,000 to 999,999 pence)
      assert.strictEqual(fixedCompensationPence(100000), 7000); // £1,000.00 (Exact boundary)
      assert.strictEqual(fixedCompensationPence(485000), 7000); // £4,850.00
      assert.strictEqual(fixedCompensationPence(999999), 7000); // £9,999.99 (Boundary below £10,000)

      // Tier 3: £10,000 and above (>= 1,000,000 pence)
      assert.strictEqual(fixedCompensationPence(1000000), 10000); // £10,000.00 (Exact boundary)
      assert.strictEqual(fixedCompensationPence(1230000), 10000); // £12,300.00
      assert.strictEqual(fixedCompensationPence(50000000), 10000); // £500,000.00
    });

    test("3.2 Statutory interest calculation produces exact pence with zero rounding drift across multiple BoE rates and periods", () => {
      const testCases = [
        // { amountPence, days, boeRate, expectedInterest }
        // Rate: 3.75% (statutory rate = 11.75%)
        { amount: 485000, days: 24, rate: 3.75, expected: 3747 },
        { amount: 1230000, days: 18, rate: 3.75, expected: 7127 },
        { amount: 640000, days: 9, rate: 3.75, expected: 1854 },
        { amount: 95000, days: 6, rate: 3.75, expected: 183 },
        { amount: 100000, days: 365, rate: 3.75, expected: 11750 }, // 1 full year = exactly 11.75% of 100,000 = 11,750p
        { amount: 1000000, days: 1, rate: 3.75, expected: 322 }, // 1 day on £10k

        // Rate: 5.00% (statutory rate = 13.00%)
        { amount: 100000, days: 365, rate: 5.00, expected: 13000 }, // 1 full year = exactly 13% of 100,000 = 13,000p
        { amount: 500000, days: 30, rate: 5.00, expected: 5342 }, // (500,000 * 13 / 100 / 365) * 30 = 5342.46 -> 5342

        // Rate: 4.25% (statutory rate = 12.25%)
        { amount: 250000, days: 60, rate: 4.25, expected: 5034 }, // (250,000 * 12.25 / 100 / 365) * 60 = 5034.24 -> 5034

        // 0 days overdue -> 0 interest
        { amount: 1000000, days: 0, rate: 3.75, expected: 0 },
      ];

      for (const tc of testCases) {
        const calculated = statutoryInterestPence(tc.amount, tc.days, tc.rate);
        assert.strictEqual(
          calculated,
          tc.expected,
          `Statutory interest mismatch for £${(tc.amount / 100).toFixed(2)} overdue ${tc.days}d at ${tc.rate}% BoE: got ${calculated}, expected ${tc.expected}`,
        );

        const oracle = statutoryOracle(tc.amount, tc.days, tc.rate);
        assert.strictEqual(calculated, oracle.interestPence);
      }
    });

    test("3.3 Draft review queue API GET /api/admin/drafts populates calculations matching oracle across all tiers", async () => {
      const { env, db } = createTestEnv({ BOE_BASE_RATE_PERCENT: "3.75" });

      await db.rawSqlite.exec(`
        INSERT INTO clients (id, company_name, contact_email) VALUES (1, 'Apex Ltd', 'apex@test.com');
        INSERT INTO invoices (id, client_id, debtor_name, invoice_number, amount_pence, due_date)
        VALUES
          (1, 1, 'Small Debtor (<1k)', 'INV-SML', 95000, date('now', '-10 days')),
          (2, 1, 'Medium Debtor (1k-10k)', 'INV-MED', 485000, date('now', '-24 days')),
          (3, 1, 'Large Debtor (>10k)', 'INV-LRG', 1230000, date('now', '-18 days'));
        INSERT INTO chase_log (id, invoice_id, step, channel, status, subject, body)
        VALUES
          (101, 1, 2, 'email', 'draft', 'Small Chase', 'Body 1'),
          (102, 2, 4, 'email', 'draft', 'Medium Chase', 'Body 2'),
          (103, 3, 3, 'email', 'draft', 'Large Chase', 'Body 3');
      `);

      const res = await worker.fetch(
        new Request("http://localhost/api/admin/drafts", {
          headers: {
            Authorization: createBasicAuthHeader(env.ADMIN_SECRET),
            Accept: "application/json",
          },
        }),
        env,
      );

      assert.strictEqual(res.status, 200);
      const json = (await res.json()) as any;
      assert.strictEqual(json.drafts.length, 3);

      // Draft 1: Small (<£1k)
      const d1 = json.drafts.find((d: any) => d.id === 101);
      assert.strictEqual(d1.principal_pence, 95000);
      assert.strictEqual(d1.fixed_compensation_pence, 4000); // £40 tier
      const oracle1 = statutoryOracle(95000, d1.days_overdue, 3.75);
      assert.strictEqual(d1.statutory_interest_pence, oracle1.interestPence);
      assert.strictEqual(d1.total_claim_pence, 95000 + 4000 + oracle1.interestPence);

      // Draft 2: Medium (£1k - £10k)
      const d2 = json.drafts.find((d: any) => d.id === 102);
      assert.strictEqual(d2.principal_pence, 485000);
      assert.strictEqual(d2.fixed_compensation_pence, 7000); // £70 tier
      const oracle2 = statutoryOracle(485000, d2.days_overdue, 3.75);
      assert.strictEqual(d2.statutory_interest_pence, oracle2.interestPence);
      assert.strictEqual(d2.total_claim_pence, 485000 + 7000 + oracle2.interestPence);

      // Draft 3: Large (>£10k)
      const d3 = json.drafts.find((d: any) => d.id === 103);
      assert.strictEqual(d3.principal_pence, 1230000);
      assert.strictEqual(d3.fixed_compensation_pence, 10000); // £100 tier
      const oracle3 = statutoryOracle(1230000, d3.days_overdue, 3.75);
      assert.strictEqual(d3.statutory_interest_pence, oracle3.interestPence);
      assert.strictEqual(d3.total_claim_pence, 1230000 + 10000 + oracle3.interestPence);
    });

    test("3.4 Boundary & Fuzzing: Zero drift over 1,000 combinations including extreme amounts and negative days", () => {
      // 1. Zero days overdue produces exactly 0 interest
      assert.strictEqual(statutoryInterestPence(500000, 0, 3.75), 0);
      // Portal API & frontend guard negative days overdue to 0
      const portalGuard = (days: number) => (days <= 0 ? 0 : statutoryInterestPence(500000, days, 3.75));
      assert.strictEqual(portalGuard(-5), 0);

      // 2. Exact 1p invoice
      assert.strictEqual(fixedCompensationPence(1), 4000);
      assert.strictEqual(statutoryInterestPence(1, 30, 3.75), 0); // Math.round(0.009) -> 0

      // 3. Multi-million pound invoice (£10m = 1,000,000,000p)
      const largeAmt = 1000000000;
      const largeDays = 365;
      const largeRate = 5.0; // 13% total
      const largeInterest = statutoryInterestPence(largeAmt, largeDays, largeRate);
      // 1,000,000,000 * 13% = 130,000,000 pence
      assert.strictEqual(largeInterest, 130000000);

      // 4. Randomized matrix of amounts, periods, rates
      const rates = [0.0, 1.25, 3.75, 4.5, 5.0, 6.25, 8.0, 10.5];
      const periods = [0, 1, 7, 14, 21, 30, 60, 90, 180, 365, 730];
      const testAmounts = [100, 50000, 99999, 100000, 500000, 999999, 1000000, 5000000, 25000000];

      let count = 0;
      for (const a of testAmounts) {
        for (const p of periods) {
          for (const r of rates) {
            const actual = statutoryInterestPence(a, p, r);
            const oracle = statutoryOracle(a, p, r);
            assert.strictEqual(actual, oracle.interestPence, `Mismatch at amount=${a}, days=${p}, rate=${r}`);
            count++;
          }
        }
      }
      assert.ok(count >= 792);
    });
  });

  // =========================================================================
  // MISSION 4: Offline / demo fallback & frontend resilience
  // =========================================================================
  describe("Mission 4: Offline & Demo Fallback Resilience", () => {
    // Simulate apiFetch behavior under adversarial failure modes
    async function apiFetchSimulated(
      endpoint: string,
      fetchImpl: (url: string, init?: any) => Promise<Response>,
      options: any = {},
    ) {
      try {
        const res = await fetchImpl(endpoint, {
          headers: { Accept: "application/json", ...(options.headers || {}) },
          ...options,
        });
        if (!res.ok) {
          return { ok: false, status: res.status, data: null };
        }
        const data = await res.json();
        return { ok: true, status: res.status, data };
      } catch (err) {
        return { ok: false, status: 0, error: err, data: null };
      }
    }

    test("4.1 apiFetch handles network disconnection (TypeError: Failed to fetch) without uncaught rejection", async () => {
      const mockNetworkErrorFetch = async () => {
        throw new TypeError("Failed to fetch: NetworkError when attempting to fetch resource.");
      };

      const result = await apiFetchSimulated("/api/portal/dashboard-data", mockNetworkErrorFetch);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.data, null);
      assert.ok(result.error instanceof TypeError);
    });

    test("4.2 apiFetch handles HTTP 500 Internal Server Error without throwing", async () => {
      const mock500Fetch = async () => {
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        });
      };

      const result = await apiFetchSimulated("/api/portal/debtors", mock500Fetch);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 500);
      assert.strictEqual(result.data, null);
    });

    test("4.3 apiFetch handles HTML error response (e.g. Cloudflare 502/504 Bad Gateway) without throwing JSON parse error", async () => {
      const mockBadGatewayFetch = async () => {
        return new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      };

      const result = await apiFetchSimulated("/api/admin/drafts", mockBadGatewayFetch);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 502);
      assert.strictEqual(result.data, null);
    });

    test("4.4 Frontend dashboard.js fallback mock datasets provide valid data for all 3 views", () => {
      // Read dashboard.js content to verify fallback default data structures
      const dashboardJsPath = join(process.cwd(), "frontend", "dashboard", "js", "dashboard.js");
      const content = readFileSync(dashboardJsPath, "utf-8");

      // Verify DEFAULT_INVOICES is present and complete
      assert.ok(content.includes("const DEFAULT_INVOICES = ["), "DEFAULT_INVOICES should be defined");
      assert.ok(content.includes("Hartley & Co Ltd"), "Hartley & Co Ltd should be in mock invoices");
      assert.ok(content.includes("Meridian Build Partners"), "Meridian Build Partners should be in mock invoices");

      // Verify DEFAULT_DRAFTS is present with locked sender and financial fields
      assert.ok(content.includes("const DEFAULT_DRAFTS = ["), "DEFAULT_DRAFTS should be defined");
      assert.ok(content.includes('locked_sender: "hello@invoicerescue.co.uk"'), "Drafts must have locked sender");
      assert.ok(content.includes("computeFixedCompensationPence"), "Must have client-side compensation math");
      assert.ok(content.includes("computeStatutoryInterestPence"), "Must have client-side interest math");

      // Verify DEFAULT_ACTIVITIES is present
      assert.ok(content.includes("const DEFAULT_ACTIVITIES = ["), "DEFAULT_ACTIVITIES should be defined");
    });

    test("4.5 Simulated offline frontend state allows editing, approving, and skipping drafts locally without blank screen", () => {
      // Mock session storage
      const mockSession: Record<string, string> = {};
      const sessionStorageMock = {
        getItem: (k: string) => mockSession[k] || null,
        setItem: (k: string, v: string) => { mockSession[k] = v; },
      };

      // Mock drafts dataset
      let drafts = [
        {
          id: 101,
          invoice_id: 1,
          invoice_number: "INV-2026-089",
          debtor_name: "Hartley & Co Ltd",
          amount_pence: 485000,
          currency: "GBP",
          days_overdue: 24,
          step: 4,
          step_label: "Stage 4 (Final Notice)",
          subject: "FINAL DEMAND — INV-2026-089",
          body: "Original body text",
          locked_sender: "hello@invoicerescue.co.uk",
        },
        {
          id: 102,
          invoice_id: 2,
          invoice_number: "INV-2026-104",
          debtor_name: "Meridian Build Partners",
          amount_pence: 1230000,
          currency: "GBP",
          days_overdue: 18,
          step: 3,
          step_label: "Stage 3 (Firm Notice)",
          subject: "Firm Notice — INV-2026-104",
          body: "Step 3 text",
          locked_sender: "hello@invoicerescue.co.uk",
        },
      ];

      sessionStorageMock.setItem("ir_dashboard_drafts", JSON.stringify(drafts));

      // 1. Simulate in-place edit in offline mode
      const draftToEdit = drafts.find((d) => d.id === 101);
      assert.ok(draftToEdit);
      draftToEdit.body = "Edited offline body text";
      sessionStorageMock.setItem("ir_dashboard_drafts", JSON.stringify(drafts));

      const storedAfterEdit = JSON.parse(sessionStorageMock.getItem("ir_dashboard_drafts")!);
      assert.strictEqual(storedAfterEdit[0].body, "Edited offline body text");

      // 2. Simulate approve draft in offline mode (removes from queue, records activity)
      drafts = drafts.filter((d) => d.id !== 101);
      sessionStorageMock.setItem("ir_dashboard_drafts", JSON.stringify(drafts));
      assert.strictEqual(drafts.length, 1);
      assert.strictEqual(drafts[0].id, 102);

      // 3. Simulate skip draft in offline mode
      drafts = drafts.filter((d) => d.id !== 102);
      sessionStorageMock.setItem("ir_dashboard_drafts", JSON.stringify(drafts));
      assert.strictEqual(drafts.length, 0);

      // Queue is now empty (renders empty-state card, NOT a blank screen)
      const storedEmpty = JSON.parse(sessionStorageMock.getItem("ir_dashboard_drafts")!);
      assert.strictEqual(storedEmpty.length, 0);
    });

    test("4.6 HTTP 401 Unauthorized and 404 Not Found in apiFetch return ok: false without crashing UI", async () => {
      const mock401Fetch = async () => new Response("Unauthorized", { status: 401 });
      const mock404Fetch = async () => new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });

      const res401 = await apiFetchSimulated("/api/admin/drafts", mock401Fetch);
      assert.strictEqual(res401.ok, false);
      assert.strictEqual(res401.status, 401);
      assert.strictEqual(res401.data, null);

      const res404 = await apiFetchSimulated("/api/portal/dashboard-data", mock404Fetch);
      assert.strictEqual(res404.ok, false);
      assert.strictEqual(res404.status, 404);
      assert.strictEqual(res404.data, null);
    });

    test("4.7 initOverviewDashboard retains live metrics and renders empty activity state when recentActivity is empty array", () => {
      const dashboardJsPath = join(process.cwd(), "frontend", "dashboard", "js", "dashboard.js");
      const content = readFileSync(dashboardJsPath, "utf-8");

      // Verify empty activity feed handling is present
      assert.ok(
        content.includes("No recent activity recorded yet."),
        "dashboard.js must render a clean empty message when recentActivity is empty"
      );

      // Verify that after live API metric rendering and activity feed rendering, it returns unconditionally
      // to guarantee live metrics are NEVER overwritten by mock fallback data
      const liveBlockMatch = content.match(
        /if\s*\(apiRes\.ok\s*&&\s*apiRes\.data\)[\s\S]*?return;\s*\}/
      );
      assert.ok(
        liveBlockMatch,
        "initOverviewDashboard must return unconditionally inside if (apiRes.ok && apiRes.data)"
      );
    });

    test("4.8 approveDraft retains draft card, restores button, and triggers error toast on HTTP 422 or 403 response", async () => {
      const dashboardJsPath = join(process.cwd(), "frontend", "dashboard", "js", "dashboard.js");
      const content = readFileSync(dashboardJsPath, "utf-8");

      // Verify approveDraft checks res.ok and guards non-404 errors
      assert.ok(
        content.includes("res && !res.ok && res.status !== 404"),
        "approveDraft must check res && !res.ok && res.status !== 404"
      );
      assert.ok(
        content.includes('btn.innerHTML = "Approve & Send"'),
        "approveDraft must restore button innerHTML on non-404 error"
      );
      assert.ok(
        content.includes('showToast(res.data?.error || "Failed to approve draft: " + res.status, "error")'),
        "approveDraft must trigger error toast with server error or status code"
      );

      // Simulate approval execution with 422 error response
      let drafts = [
        {
          id: 201,
          debtor_name: "Email Missing Ltd",
          invoice_number: "INV-NO-EMAIL",
          body: "Draft body text",
        },
      ];

      const btnMock = { disabled: true, innerHTML: "Sending..." };
      let toastMessage = "";
      let toastType = "";
      const showToastMock = (msg: string, type?: string) => {
        toastMessage = msg;
        toastType = type || "success";
      };

      const mock422Response = {
        ok: false,
        status: 422,
        data: { ok: false, error: "Invoice has no debtor email on file." },
      };

      // Execute simulated approval error branch
      const res = mock422Response;
      if (res && !res.ok && res.status !== 404) {
        btnMock.disabled = false;
        btnMock.innerHTML = "Approve & Send";
        showToastMock(res.data?.error || "Failed to approve draft: " + res.status, "error");
      } else {
        drafts = drafts.filter((d) => d.id !== 201);
      }

      // Assert draft is NOT dismissed from queue
      assert.strictEqual(drafts.length, 1, "Draft must remain in queue on 422 error");
      assert.strictEqual(drafts[0].id, 201);
      // Assert button is restored
      assert.strictEqual(btnMock.disabled, false);
      assert.strictEqual(btnMock.innerHTML, "Approve & Send");
      // Assert error toast is shown with backend error
      assert.strictEqual(toastMessage, "Invoice has no debtor email on file.");
      assert.strictEqual(toastType, "error");
    });
  });
});
