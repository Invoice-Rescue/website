// Late Payment of Commercial Debts (Interest) Act 1998 calculator logic.
// Pure ES module: imported by index.html in the browser and by
// tests/late-payment-calculator.test.ts under tsx. No DOM access here.
//
// Rate rule (SI 2002/1675 art. 4): 8% over the Bank of England rate in force on
// 31 Dec (interest starting 1 Jan–30 Jun) or 30 Jun (interest starting
// 1 Jul–31 Dec). The rate is fixed for the whole debt by when interest starts.
// Source for every value below: https://www.bankofengland.co.uk/boeapps/database/Bank-Rate.asp
//
// UPDATE EVERY 1 JANUARY AND 1 JULY: add the new half-year key and bump RATES_CHECKED.
// A scheduled task opens a PR for this; see the PR it raises, don't hand-merge blind.

export const REF_RATES = {
  "2020-H1": 0.75, "2020-H2": 0.10, "2021-H1": 0.10, "2021-H2": 0.10,
  "2022-H1": 0.25, "2022-H2": 1.25, "2023-H1": 3.50, "2023-H2": 5.00,
  "2024-H1": 5.25, "2024-H2": 5.25, "2025-H1": 4.75, "2025-H2": 4.25,
  "2026-H1": 3.75, "2026-H2": 3.75,
};

export const RATES_CHECKED = "2026-10-15";

const STATUTORY_MARGIN = 8;
const DAY_MS = 86_400_000;

// UTC midnight so a BST/GMT switch inside the period never shaves a day off.
export function toUTC(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

// Same bands as backend/src/lib/statutory-interest.ts fixedCompensationPence().
export function fixedCompensation(amount) {
  if (amount < 1000) return 40;
  if (amount < 10000) return 70;
  return 100;
}

export function calcInvoice(amount, dueISO, endISO) {
  if (!(amount > 0)) return { error: "Enter the invoice total." };
  if (!dueISO) return { error: "Enter the due date." };
  const due = toUTC(dueISO);
  const days = Math.round((toUTC(endISO) - due) / DAY_MS);
  if (days <= 0) return { error: "Not overdue on that date." };

  const start = new Date(due + DAY_MS); // interest runs from the day after the due date
  const key = `${start.getUTCFullYear()}-${start.getUTCMonth() < 6 ? "H1" : "H2"}`;
  const ref = REF_RATES[key];
  if (ref === undefined) {
    return { error: "No rate on file for that period. Claims over six years old are usually time-barred." };
  }

  const rate = STATUTORY_MARGIN + ref;
  const interest = Math.round(amount * rate / 100 * days / 365 * 100) / 100;
  return { days, ref, rate, interest, comp: fixedCompensation(amount), daily: amount * rate / 100 / 365 };
}
