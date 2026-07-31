/**
 * Late Payment of Commercial Debts (Interest) Act 1998 — statutory interest
 * (Bank of England base rate + 8% margin, simple daily accrual) and the
 * fixed-sum compensation bands from the 2013 amending regulations.
 *
 * ponytail: the base rate changes twice a year and is read from
 * env.BOE_BASE_RATE_PERCENT (see wrangler.jsonc) rather than hardcoded here —
 * but that var still needs a human to update it. Verify the current published
 * rate before using this for a real client invoice.
 */
const STATUTORY_MARGIN_PERCENT = 8;

export function fixedCompensationPence(amountPence: number): number {
  if (amountPence < 100_000) return 4000; // < £1,000 → £40
  if (amountPence < 1_000_000) return 7000; // £1,000–£9,999.99 → £70
  return 10000; // ≥ £10,000 → £100
}

export function statutoryInterestPence(
  amountPence: number,
  daysOverdue: number,
  boeBaseRatePercent: number,
): number {
  const annualRatePercent = boeBaseRatePercent + STATUTORY_MARGIN_PERCENT;
  return Math.round(((amountPence * annualRatePercent) / 100 / 365) * daysOverdue);
}
