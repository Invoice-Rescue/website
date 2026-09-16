# Empirical Challenge Report: Milestone M2 (Statutory Calculation Precision & Locked Sender - R2)

**Challenger**: Challenger 2 (Empirical Challenger)  
**Target**: Milestone M2 Implementation (`backend/src/lib/statutory-interest.ts`, `backend/src/lib/chase-runner.ts`, `backend/src/lib/gemini.ts`, `backend/src/lib/escalation.ts`)  
**Verdict**: **APPROVE**  
**Overall Risk Assessment**: **LOW**  
**Date**: 2026-09-16  

---

## 1. Executive Summary

As Empirical Challenger 2, I subjected Milestone M2 to intensive adversarial stress testing across 15 automated test cases implemented in `tests/challenger-m2-stress.test.ts`. All test cases were directly executed against the real runtime and SQLite database harness.

Key empirical findings:
1. **Statutory Interest Precision & Zero Accumulation Drift**: The closed-form implementation `Math.round(((amountPence * (boeBaseRatePercent + 8)) / 100 / 365) * daysOverdue)` completely avoids day-by-day rounding compounding error. Accrual across leap years (366 days), multi-year debts (730, 1095, 1460 days), and base rate variations (0.10% to 15.0%) maintains zero drift. Over 1,000 consecutive days of debt aging, interest was strictly monotonic with zero negative or irregular steps.
2. **Boundary Compensation Tier Precision**: Tested exact boundary pence values under the UK Late Payment of Commercial Debts Act 1998 / 2013 Regulations: £999.99 (99,999p) yields £40 (4000p), £1,000.00 (100,000p) yields £70 (7000p), £9,999.99 (999,999p) yields £70 (7000p), and £10,000.00 (1,000,000p) yields £100 (10000p). Sub-penny floating values (99,999.9p and 999,999.9p) classify without flaw.
3. **Locked Sender & Prompt Construction Invariants**: Tested prompt construction and fallback drafts across all 4 stages for multiple companies (including names with symbols, quotes, and punctuation). `[Client Business Name]` was completely absent in 100% of cases. The genuine client business name is reliably populated into merge fields and mandatory sign-offs. Outbound communications are strictly authenticated from `hello@invoicerescue.co.uk` and signed by `Tibor Rames` on behalf of the client.
4. **Quality Gates**: All 376 tests in the test suite pass (100%), TypeScript type check passes with 0 errors, Cloudflare Worker dry-run build succeeds cleanly, and D1 migrations apply with zero schema drift.

---

## 2. Adversarial Challenges & Results

### Challenge 1: Daily Accrual Rounding Drift Across Leap Years & Multi-Year Horizons
- **Assumption Challenged**: Dividing by 365 or day-by-day penny rounding across 366-day leap years or multi-year debts (730+ days) introduces cumulative rounding drift or precision divergence in JavaScript's 64-bit float IEEE 754 arithmetic.
- **Empirical Test**:
  - Test 1.1: £1,000.00 at BoE 3.75% (11.75% total) evaluated for Day 365 (11,750p = £117.50) and Day 366 (11,782p = £117.82). The delta for the single leap day was verified to be exactly 32p (`round(11750 / 365)`), with zero drift.
  - Test 1.2: Evaluated debts at 730 days (2 * 365), 1095 days (3 * 365), and 1460 days (4 * 365) across 4 base rates (0.0%, 2.0%, 4.0%, 5.0%). In every case where annual interest is an integer number of pence, year 2 interest was strictly equal to `2 * Year 1`, year 3 equal to `3 * Year 1`, and year 4 equal to `4 * Year 1`. Drift was exactly 0 pence.
  - Test 1.3: Evaluated 1,000 consecutive days of interest on £5,432.10 at BoE 3.75%. Monotonicity was maintained for 100% of days (`interest(d) >= interest(d - 1)`), each daily step was bounded strictly between `floor(daily)` and `ceil(daily)`, and deviation from unrounded exact value was `<= 0.5p`.
- **Verdict**: **PASS** (Zero accumulation drift confirmed).

### Challenge 2: Boundary Compensation Transitions
- **Assumption Challenged**: Off-by-one errors at the statutory thresholds (£1,000.00 and £10,000.00) or floating-point rounding could misclassify £999.99 into the £70 band, or £9,999.99 into the £100 band.
- **Empirical Test**:
  - Test 2.1: 99,998p -> 4000p; 99,999p (£999.99) -> 4000p; 100,000p (£1,000.00) -> 7000p; 100,001p -> 7000p.
  - Test 2.2: 999,998p -> 7000p; 999,999p (£9,999.99) -> 7000p; 1,000,000p (£10,000.00) -> 10000p; 1,000,001p -> 10000p.
  - Test 2.3: Zero (0p -> 4000p), 1 penny (1p -> 4000p), sub-penny floats (99,999.9p -> 4000p, 999,999.9p -> 7000p), and massive principal (£500,000 -> 10000p).
- **Verdict**: **PASS** (100% accurate statutory classification).

### Challenge 3: Fallback Placeholder Leakage & Locked Sender Identity
- **Assumption Challenged**: The fallback placeholder `[Client Business Name]` in `backend/src/lib/gemini.ts` could leak into generated prompts or fallback drafts if client company name binding fails or is omitted.
- **Empirical Test**:
  - Test 3.1: Generated prompts for all 4 stages across 5 diverse client companies (with apostrophes, ampersands, Ltd, PLC, LLP). Confirmed zero occurrences of `[Client Business Name]`. Confirmed mandatory sign-off format: `Tibor Rames\nInvoice Rescue — acting on behalf of ${company}\nhello@invoicerescue.co.uk`.
  - Test 3.2: Generated fallback drafts for all 4 stages when Gemini API is offline. Confirmed zero occurrences of `[Client Business Name]`, presence of genuine client company name, statutory interest, compensation, and locked sign-off.
  - Test 3.3: Dispatched `runOverdueDetection` against real D1 database with Step 1 and Step 3 invoices. Intercepted HTTP fetch requests to Google Gemini REST API. Verified captured prompts contained `Client Business: Helix Interactive Media Ltd`, `FROM: hello@invoicerescue.co.uk`, and zero `[Client Business Name]`. Draft rows inserted into SQLite `chase_log` confirmed identical invariants.
  - Test 3.4: Dispatched `POST /api/chase/:id/approve` through worker routing. Verified outbound email dispatched via `env.SEND` had `from.email: "hello@invoicerescue.co.uk"`, `from.name: "Invoice Rescue"`, body signed by `Tibor Rames` on behalf of client, and zero placeholder text.
- **Verdict**: **PASS** (Zero placeholder leakage, locked sender strictly enforced).

### Challenge 4: Multi-Tenant Batch Concurrency & Leap Day Calendar Boundaries
- **Assumption Challenged**: Large batches of overdue invoices across multiple tenants could leak company names across rows or miscalculate operator notification summaries. Leap days (`2024-02-29`, `2028-02-29`) could crash SQLite date math or `diffDays`.
- **Empirical Test**:
  - Test 4.1: Parsed `2024-02-28`, `2024-02-29`, `2024-03-01`, and full leap year `2028-01-01` to `2029-01-01`. Day differences evaluated to exact integer day counts (1, 2, 365, 366).
  - Test 4.2: Ingested 30 overdue invoices across 3 separate client companies simultaneously. Executed `runOverdueDetection`. Exactly 30 drafts were generated with 0 errors. Each draft matched its specific client company name with zero cross-tenant contamination. A single consolidated notification was delivered to operator inbox alerting to 30 drafts.
  - Test 4.3: Injected adversarial characters (SQL injection strings, XML tags, unicode accents, quotes) into debtor and client company names. Both prompt generation and fallback drafting handled all strings without corruption.
- **Verdict**: **PASS** (Robust under batch multi-tenant stress).

---

## 3. Stress Test Results Summary

| Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|
| Leap year (366 days) £1,000 @ 3.75% BoE | 11,782 pence (£117.82), 32p leap day step | 11,782 pence, delta = 32p | **PASS** |
| Multi-year debts (730, 1095, 1460 days) | Exact integer multiple of annual interest | Exact integer multiple, 0 drift | **PASS** |
| 1,000-day aging simulation | Strict monotonicity, bounded daily step | Monotonic across 1,000 days | **PASS** |
| Base rate changes (0.1% to 15.0%) | Matches statutory BoE + 8% daily accrual | 100% exact match | **PASS** |
| Microscopic debt (1p, 100p) | Rounded correctly (0p, 12p) | 0p, 12p | **PASS** |
| Massive debt (£10,000,000, 730d @ 5% BoE) | 260,000,000p (£2,600,000.00) without float overflow | 260,000,000p | **PASS** |
| Boundary tier: £999.98 & £999.99 | 4000 pence (£40) | 4000 pence | **PASS** |
| Boundary tier: £1,000.00 & £1,000.01 | 7000 pence (£70) | 7000 pence | **PASS** |
| Boundary tier: £9,999.98 & £9,999.99 | 7000 pence (£70) | 7000 pence | **PASS** |
| Boundary tier: £10,000.00 & £10,000.01 | 10000 pence (£100) | 10000 pence | **PASS** |
| Sub-penny floats: 99,999.9p & 999,999.9p | 4000p & 7000p | 4000p & 7000p | **PASS** |
| Prompts: all stages (1-4) & 5 companies | Genuine name, zero `[Client Business Name]` | 0 placeholder occurrences | **PASS** |
| Fallbacks: all stages (1-4) & 5 companies | Signed Tibor Rames, locked sender, genuine name | Exact sign-off, zero placeholder | **PASS** |
| Live D1 prompt capture during cron | Intercepted prompt contains genuine client name | Genuine client name verified | **PASS** |
| Operator approve & send | Dispatched via `env.SEND` with locked sender | `hello@invoicerescue.co.uk` verified | **PASS** |
| Leap day calendar date math | 2024-02-29 and 2028-02-29 parsed accurately | 1d / 366d exact | **PASS** |
| Batch 30 invoices across 3 clients | Isolated drafts, consolidated operator email | 30 drafts, 1 alert | **PASS** |
| Adversarial inputs (SQL, XML, unicode) | Escaped/preserved without crashing | Clean output | **PASS** |

---

## 4. Verification Output Record

- **Empirical Test Suite**:
  ```
  npx tsx --test tests/challenger-m2-stress.test.ts
  ✔ 1. Statutory Interest Precision & Accumulation Drift (7.52ms)
  ✔ 2. Statutory Compensation Boundary Tiers (1.34ms)
  ✔ 3. Locked Sender Model & Prompt Construction Invariants (47.73ms)
  ✔ 4. Leap Day Date Arithmetic & Multi-Tenant Batch Invariant Stress (21.00ms)
  ℹ tests 15, pass 15, fail 0 (Duration: 632ms)
  ```
- **Full Automated Test Suite**:
  ```
  npm test
  ℹ tests 376, suites 75, pass 376, fail 0 (Duration: 3238ms)
  ```
- **TypeScript Typecheck**:
  ```
  npx tsc --noEmit
  Exit code 0 (0 errors)
  ```
- **Cloudflare Worker Dry-Run Bundle**:
  ```
  npm run build
  wrangler deploy --dry-run
  Exit code 0 (Clean bundle)
  ```
- **D1 Migrations Status**:
  ```
  npx wrangler d1 migrations apply invoice-rescue-db --local
  Resource location: local
  ✅ No migrations to apply!
  ```

---

## 5. Unchallenged Areas

- **Live External Google Gemini API**: Stress testing used intercepted network mocks to verify prompt format and error handling rather than live API calls consuming billable quota. Fallback generation under API 503 errors was empirically tested and confirmed.
- **Physical SMTP Gateway Delivery**: Cloudflare `send_email` bindings (`NOTIFY` and `SEND`) were tested using verified test fixtures in memory to confirm envelope addresses and headers. Real SMTP transit to external mail servers was not challenged.

---

## 6. Verdict

**APPROVE**  
Milestone M2 meets all requirements for statutory calculation precision, boundary compensation classification, cadence spacing, pending draft gating, terminal escalation, and the locked sender model with zero detected regressions or vulnerabilities.
