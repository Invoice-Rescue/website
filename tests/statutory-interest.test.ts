import { test, describe } from "node:test";
import assert from "node:assert";
import { fixedCompensationPence, statutoryInterestPence } from "../backend/src/lib/statutory-interest";

describe("statutory-interest", () => {
  test("fixed compensation follows statutory tiers under Late Payment of Commercial Debts Act", () => {
    // Under £1,000 (< 100,000 pence) -> £40 (4,000 pence)
    assert.strictEqual(fixedCompensationPence(0), 4000);
    assert.strictEqual(fixedCompensationPence(50_000), 4000);
    assert.strictEqual(fixedCompensationPence(99_999), 4000);

    // £1,000 to £9,999.99 (100,000 to 999,999 pence) -> £70 (7,000 pence)
    assert.strictEqual(fixedCompensationPence(100_000), 7000);
    assert.strictEqual(fixedCompensationPence(500_000), 7000);
    assert.strictEqual(fixedCompensationPence(999_999), 7000);

    // £10,000 and above (>= 1,000,000 pence) -> £100 (10,000 pence)
    assert.strictEqual(fixedCompensationPence(1_000_000), 10000);
    assert.strictEqual(fixedCompensationPence(5_000_000), 10000);
  });

  test("calculates daily statutory interest accurately (BoE base rate + 8%)", () => {
    const boeRate = 3.75; // 3.75% + 8.00% = 11.75% annual rate
    const amountPence = 100_000; // £1,000

    // Full year (365 days): exactly 11.75% of 100,000 = 11,750 pence
    const fullYearInterest = statutoryInterestPence(amountPence, 365, boeRate);
    assert.strictEqual(fullYearInterest, 11750);

    // Zero days overdue: 0 pence
    const zeroDaysInterest = statutoryInterestPence(amountPence, 0, boeRate);
    assert.strictEqual(zeroDaysInterest, 0);

    // 30 days overdue on £5,000 (500,000 pence)
    // (500,000 * 11.75 / 100 / 365) * 30 = 4828.767... rounded to 4829 pence
    const thirtyDaysInterest = statutoryInterestPence(500_000, 30, boeRate);
    assert.strictEqual(thirtyDaysInterest, 4829);
  });
});
