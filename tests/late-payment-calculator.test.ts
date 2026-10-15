import { test, describe } from "node:test";
import assert from "node:assert";
import { REF_RATES, calcInvoice, fixedCompensation } from "../frontend/late-payment-calculator/calc.js";
import { fixedCompensationPence } from "../backend/src/lib/statutory-interest";

describe("late-payment-calculator", () => {
  test("hand-worked case: £2,400, 74 days late, overdue in H2 2026 at 11.75%", () => {
    // 2400 × 0.1175 × 74 / 365 = 57.1726... → £57.17
    const r = calcInvoice(2400, "2026-08-01", "2026-10-14");
    assert.strictEqual(r.days, 74);
    assert.strictEqual(r.rate, 11.75);
    assert.strictEqual(r.interest, 57.17);
    assert.strictEqual(r.comp, 70);
  });

  test("rate is fixed by the half-year interest starts in, not the due date", () => {
    // Due 31 Dec 2025 → interest starts 1 Jan 2026 → 31 Dec 2025 rate (3.75)
    assert.strictEqual(calcInvoice(500, "2025-12-31", "2026-01-31").ref, 3.75);
    // Due 30 Jun 2025 → interest starts 1 Jul 2025 → 30 Jun 2025 rate (4.25)
    assert.strictEqual(calcInvoice(500, "2025-06-30", "2025-07-30").ref, 4.25);
    // Due 29 Jun 2025 → interest starts 30 Jun 2025 → 31 Dec 2024 rate (4.75)
    assert.strictEqual(calcInvoice(500, "2025-06-29", "2025-07-29").ref, 4.75);
  });

  test("rejects bad input and periods with no rate on file", () => {
    assert.ok(calcInvoice(0, "2026-01-01", "2026-02-01").error);
    assert.ok(calcInvoice(500, "", "2026-02-01").error);
    assert.ok(calcInvoice(500, "2026-02-01", "2026-02-01").error);
    assert.ok(calcInvoice(500, "2019-03-01", "2019-04-01").error);
  });

  test("compensation bands match the backend's", () => {
    for (const pounds of [0.01, 999.99, 1000, 9999.99, 10000, 50000]) {
      assert.strictEqual(fixedCompensation(pounds) * 100, fixedCompensationPence(Math.round(pounds * 100)));
    }
  });

  test("rate table has no gaps between 2020-H1 and the latest half-year", () => {
    const keys = Object.keys(REF_RATES);
    const [first, last] = [keys[0], keys[keys.length - 1]];
    const expected: string[] = [];
    for (let y = +first.slice(0, 4); ; y++) {
      for (const h of ["H1", "H2"]) {
        const k = `${y}-${h}`;
        if (k >= first) expected.push(k);
        if (k === last) { assert.deepStrictEqual(keys, expected); return; }
      }
    }
  });
});
