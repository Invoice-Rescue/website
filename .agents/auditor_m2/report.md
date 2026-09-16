# Forensic Audit Report: Milestone M2 (Credit-Control Escalation & Statutory Calculation Engine - R2)

**Work Product**:
- `backend/src/lib/chase-runner.ts`
- `backend/src/lib/statutory-interest.ts`
- `backend/src/lib/escalation.ts`
- `backend/src/lib/gemini.ts`
- `backend/src/index.ts`
- `tests/chase-runner.test.ts`

**Profile**: General Project (Integrity Forensics)  
**Integrity Mode**: Demo Mode (per `ORIGINAL_REQUEST.md`)  
**Verdict**: **CLEAN**

---

## Executive Summary

A comprehensive, adversarial forensic audit was performed on the Milestone M2 deliverable. All code implementations and test suites were scrutinized across two forensic investigation phases: mode-agnostic static/dynamic analysis and Demo-mode constraint evaluation. All 4 quality gates were verified independently through empirical execution. Zero integrity violations, zero hardcoded test outputs, zero facade implementations, zero pre-populated verification artifacts, and zero unauthorized runtime dependencies were found.

---

## Phase Results

### 1. Static Analysis & Prohibited Patterns: PASS
- **Hardcoded test results**: PASS. Zero test strings, mock outputs, or PASS/FAIL strings embedded in production code. Inspected all modules in `backend/src/lib/` for test names and test environment flags; found none.
- **Facade implementations**: PASS. All functions in `chase-runner.ts`, `statutory-interest.ts`, `escalation.ts`, and `gemini.ts` implement genuine computational logic.
- **Pre-populated artifacts**: PASS. Exhaustive search for `*.log`, `*result*`, and `*output*` across the repository returned 0 pre-populated artifacts.
- **Dependency audit**: PASS. Zero external runtime dependencies in `package.json` (`dependencies: {}`). Gemini API calls use standard global `fetch` with no SDK; Web Crypto uses `crypto.subtle`; D1 queries use native prepared statements.

### 2. Statutory Calculation & Formula Integrity: PASS
- **Statutory interest calculation**: PASS. Implements UK Late Payment of Commercial Debts (Interest) Act 1998 simple daily interest: `Math.round(((amountPence * (boeBaseRatePercent + 8)) / 100 / 365) * daysOverdue)`. Accurately calculates interest with zero rounding drift.
- **Statutory compensation fee tiers**: PASS. Evaluates tiers under 2013 amending regulations:
  - `< £1,000` (< 100,000p) → £40 (4,000p)
  - `£1,000` to `£9,999.99` (100,000p to 999,999p) → £70 (7,000p)
  - `≥ £10,000` (≥ 1,000,000p) → £100 (10,000p)

### 3. Cadence State Machine & Escalation Integrity: PASS
- **4-Stage Escalation Cadence**: PASS. Stage 1 triggers at 1+ days overdue; Stages 2, 3, and 4 require at least 7 days to elapse since the prior chase step was sent (`diffDays(currentDate, lastChaseDate) >= 7`). Late-imported invoices are prevented from rapid-firing consecutive stages.
- **Pending Draft Gating**: PASS. If a draft is already pending in `chase_log` (`status = 'draft'`), the runner skips drafting for that invoice, preventing duplicate conflicting drafts.
- **Terminal State Isolation**: PASS. `invoices` in terminal states (`paid`, `escalated`, `disputed`, `promised`) are excluded by `WHERE i.status = 'overdue'`. Invoices reaching Stage 4 final notice with 7+ days elapsed without payment transition to `escalated` and trigger an operator alert via `env.NOTIFY`.
- **Locked Sender & Sign-off Model**: PASS. Prompts generated for Gemini and fallback templates strictly adhere to `FROM: hello@invoicerescue.co.uk` and sign-off `Tibor Rames\nInvoice Rescue — acting on behalf of ${clientName}\nhello@invoicerescue.co.uk`. The genuine client company name (`inv.company_name`) is dynamically bound; the fallback placeholder `[Client Business Name]` is never emitted.

### 4. Quality Gates Verification: PASS
- **Gate 1 (TypeScript Strict Type Check)**: PASS (`npx tsc --noEmit` exited 0 with 0 errors).
- **Gate 2 (Automated Test Suite)**: PASS (`npm test` passed 361/361 tests across 70 suites in 4.58s; `npx tsx --test tests/chase-runner.test.ts` passed 7/7 targeted tests).
- **Gate 3 (Worker Dry-Run Build)**: PASS (`npm run build` / `wrangler deploy --dry-run` bundled cleanly with 0 errors).
- **Gate 4 (D1 Migrations Application)**: PASS (`npx wrangler d1 migrations apply invoice-rescue-db --local` reported "No migrations to apply!").

---

## Adversarial Challenge & Stress-Testing

| Scenario | Attack Vector / Hypothesis | Observed Behavior | Verdict |
|----------|---------------------------|-------------------|---------|
| Late Ingestion Spike | Invoice imported 20 days overdue runs on Day 20, 21, 26, 27 | Day 20 creates Stage 1 draft; Days 21 and 26 defer (1d and 6d elapsed); Day 27 creates Stage 2 draft (7d elapsed). | PASS |
| Operator Queue Backlog | Operator does not review Stage 1 draft for multiple days | Cron runs inspect `chase_log WHERE status = 'draft'` and skip creating duplicate drafts. | PASS |
| Gemini API Failure | Google Gemini API returns HTTP 503 or safety block | `runOverdueDetection` catches error, logs it in `result.errors`, and invokes `generateFallbackDraft`, generating a complete, legally compliant draft. | PASS |
| Stage 4 Exhaustion | Stage 4 final notice sent 8 days ago without payment | Invoice transitions to `status = 'escalated'`, operator alert sent via `env.NOTIFY`, and subsequent cron runs ignore invoice. | PASS |
| Zero / Negative Amounts | Zero or negative days overdue | `statutoryInterestPence(100_000, 0, 3.75)` returns 0 pence; `due_date < date('now')` prevents non-overdue invoices from entering chase sequence. | PASS |

---

## Evidence

### 1. Quality Gate 1: TypeScript Check
```
$ npx tsc --noEmit
Exit code: 0
```

### 2. Quality Gate 2: Full Test Suite
```
$ npm test
ℹ tests 361
ℹ suites 70
ℹ pass 361
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4579.1558
Exit code: 0
```

### 3. Quality Gate 2b: Targeted Chase Runner Tests
```
$ npx tsx --test tests/chase-runner.test.ts
▶ Chase Runner: Credit-Control Escalation & Statutory Calculation Engine
  ✔ R2.1: runOverdueDetection passes genuine clientBusinessName to prompt and never falls back to [Client Business Name] (89.5255ms)
  ✔ R2.2: 7-day cadence spacing is strictly enforced for late-imported invoices (26.7749ms)
  ✔ R2.3: Pending draft gating prevents generating duplicate drafts while unreviewed (13.6648ms)
  ✔ R2.4: Terminal state transition to escalated occurs 7+ days after Stage 4 final notice (10.7699ms)
  ✔ R2.5: Stage 4 does NOT transition to escalated before 7 days have elapsed (14.4184ms)
  ✔ R2.6: Fallback template draft is safely generated when Gemini API is unavailable (14.4611ms)
  ✔ R2.7: parseDate and diffDays correctly handle SQLite timestamps and day differences (0.4372ms)
ℹ tests 7
ℹ suites 1
ℹ pass 7
ℹ fail 0
Exit code: 0
```

### 4. Quality Gate 3: Cloudflare Worker Dry-Run Bundle
```
$ npm run build
> invoice-rescue@1.0.0 build
> wrangler deploy --dry-run

 ⛅️ wrangler 4.131.0
✨ Read 20 files from the assets directory frontend
Total Upload: 94.86 KiB / gzip: 21.41 KiB
Your Worker has access to the following bindings:
Binding                                      Resource                  
env.NOTIFY (tiborcc2@gmail.com)              Send Email                
env.SEND (unrestricted)                      Send Email                
env.DB (invoice-rescue-db)                   D1 Database               
env.ASSETS                                   Assets                    
--dry-run: exiting now.
Exit code: 0
```

### 5. Quality Gate 4: Local D1 Migrations
```
$ npx wrangler d1 migrations apply invoice-rescue-db --local
 ⛅️ wrangler 4.131.0
Resource location: local 
✅ No migrations to apply!
Exit code: 0
```

---

## Conclusion

The Milestone M2 implementation strictly adheres to all architectural constraints, statutory requirements under the UK Late Payment of Commercial Debts (Interest) Act 1998, locked sender specifications, and engineering quality standards. The deliverable is free of integrity violations and is certified **CLEAN**.
