# Handoff Report: Milestone M2 (Credit-Control Escalation & Statutory Calculation Engine - R2)

**Agent**: Milestone M2 Explorer  
**Working Directory**: `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m2`  
**Date**: 2026-09-16  
**Type**: Hard Handoff (Task Complete)  

---

## 1. Observation

1. **Missing `chase-runner.ts`**:
   - In `backend/src/lib/`: `admin.ts`, `csv.ts`, `db.ts`, `escalation.ts`, `gemini.ts`, `integrations/`, `portal-auth.ts`, `portal.ts`, `statutory-interest.ts`, `stripe.ts`, `tenant-repo.ts`.
   - `backend/src/lib/chase-runner.ts` does not exist (`view_file` returned file not found).
   - Overdue detection and chase drafting logic is currently inline in `backend/src/index.ts:818-880` as private function `runOverdueDetection(env: Env)`.

2. **Locked Sender Sign-Off Parameter Omission**:
   - `backend/src/index.ts:822`: SQL query selects `c.company_name` and `c.voice_notes`:
     ```typescript
     SELECT ... c.company_name, c.voice_notes FROM invoices i JOIN clients c ON c.id = i.client_id
     ```
   - `backend/src/index.ts:839-851`:
     ```typescript
     const prompt = buildChasePrompt({
       clientVoiceNotes: inv.voice_notes,
       debtorName: inv.debtor_name,
       invoiceNumber: inv.invoice_number,
       amountPence: inv.amount_pence,
       currency: inv.currency,
       dueDate: inv.due_date,
       daysOverdue: inv.days_overdue,
       step,
       stepLabel: STEP_LABELS[step],
       statutoryInterestPence: interest,
       fixedCompensationPence: compensation,
       // clientBusinessName is NOT provided!
     });
     ```
   - `backend/src/lib/gemini.ts:60`:
     ```typescript
     const clientName = input.clientBusinessName || "[Client Business Name]";
     ```
   - Verbatim line 68 in `gemini.ts`:
     `Invoice Rescue — acting on behalf of ${clientName}`
     Because `clientBusinessName` was omitted, the prompt passed to Gemini contains `[Client Business Name]` verbatim instead of the client company name.

3. **Cadence Progression Logic Discrepancy**:
   - `backend/src/lib/escalation.ts:19-24`:
     ```typescript
     export function nextStepDue(daysOverdue: number, history: ChaseHistoryRow[]): number | null {
       const lastStep = history.reduce((max, h) => Math.max(max, h.step), 0);
       const nextStep = lastStep + 1;
       if (nextStep > CADENCE_DAYS.length) return null;
       return daysOverdue >= CADENCE_DAYS[nextStep - 1] ? nextStep : null;
     }
     ```
   - `backend/src/lib/escalation.ts:30-85`: `advanceEscalationStage` implements `daysSinceChase >= 7` checking, but it is **never called** in `backend/src/index.ts`.
   - `backend/src/index.ts:834`: `runOverdueDetection` queries only `SELECT step FROM chase_log WHERE invoice_id = ?1` and calls `nextStepDue(inv.days_overdue, history.results)`. It does not check `sent_at` or `status = 'sent'`. For invoices imported 15+ days overdue, it schedules Stage 1, Stage 2, and Stage 3 on successive days without the mandatory 7-day pause between chases.

4. **Terminal State Transitions**:
   - `backend/src/index.ts:824`: Query filters `WHERE i.status = 'overdue' AND i.due_date < date('now')`. Invoices marked `paid`, `disputed`, `promised`, or `escalated` are excluded from overdue processing.
   - `backend/db/migrations/0003_add_check_constraints.sql:68`:
     `status TEXT NOT NULL DEFAULT 'overdue' CHECK (status IN ('overdue', 'promised', 'disputed', 'paid', 'escalated'))`
   - Neither `runOverdueDetection` nor `nextStepDue` transitions an invoice from `overdue` to `escalated` when Stage 4 has been sent and 7+ days elapse without payment. The invoice remains `overdue` indefinitely.
   - `backend/src/types/core.ts:1` defines `EscalationStage` with `'handed_back'`, which differs from the database CHECK constraint value `'escalated'`.

5. **Statutory Calculation Precision**:
   - `backend/src/lib/statutory-interest.ts:13-26`:
     ```typescript
     export function fixedCompensationPence(amountPence: number): number {
       if (amountPence < 100_000) return 4000;
       if (amountPence < 1_000_000) return 7000;
       return 10000;
     }
     export function statutoryInterestPence(amountPence: number, daysOverdue: number, boeBaseRatePercent: number): number {
       const annualRatePercent = boeBaseRatePercent + STATUTORY_MARGIN_PERCENT;
       return Math.round(((amountPence * annualRatePercent) / 100 / 365) * daysOverdue);
     }
     ```
   - Tests in `tests/statutory-interest.test.ts` pass: 365 days @ 3.75% BoE rate on £1,000 yields exactly 11,750 pence (11.75% annual rate, 0.00p drift). Fixed compensation evaluates to £40 (<£1,000), £70 (£1,000–£9,999.99), £100 (≥£10,000).

6. **Automated Verification Results**:
   - `npm test`: 354 tests pass across 69 suites in 3,215ms. 0 failures.
   - `npx tsc --noEmit`: 0 TypeScript compiler errors.
   - `npm run build`: Dry-run bundle succeeded cleanly.
   - `npx wrangler d1 migrations list invoice-rescue-db --local`: All migrations applied, zero drift.

---

## 2. Logic Chain

1. **From Observation 1**: The prompt specified reviewing `backend/src/lib/chase-runner.ts`, but the file is absent. Because `runOverdueDetection` is an un-exported private function inside `backend/src/index.ts`, overdue detection cannot be tested in isolation or reused outside `index.ts`. Creating `backend/src/lib/chase-runner.ts` and extracting `runOverdueDetection` fulfills the architectural requirement.
2. **From Observation 2**: In `backend/src/index.ts:839`, `clientBusinessName: inv.company_name` is omitted when invoking `buildChasePrompt`. Because `buildChasePrompt` defaults to `[Client Business Name]`, the prompt generated for Gemini directly violates the locked sender requirement of signing off on behalf of the specific client business. Passing `clientBusinessName: inv.company_name` is an essential fix.
3. **From Observation 3**: The acceptance criteria mandate: "Stage 2: 7+ days after Stage 1; Stage 3: 7+ days after Stage 2; Stage 4: 7+ days after Stage 3." Because `runOverdueDetection` relies solely on `nextStepDue(daysOverdue, history)`, it only checks absolute overdue days `[1, 8, 15, 22]`. If an invoice is 20 days overdue at import, cron generates Step 1, then the next day Step 2, and the next day Step 3, ignoring the 7-day interval. Inspecting `sent_at` of the previous chase or adopting `advanceEscalationStage` resolves this flaw.
4. **From Observation 4**: Invoices that exhaust Stage 4 without payment must transition to the terminal hand-back state. Currently, `runOverdueDetection` simply continues the loop without mutating `invoices.status`. Furthermore, the SQLite schema constraint permits `'escalated'` rather than `'handed_back'`. Therefore, the runner must update `invoices.status = 'escalated'` and alert the operator via `env.NOTIFY`.
5. **From Observation 5 & 6**: The core mathematical calculations in `statutory-interest.ts` strictly satisfy the UK Late Payment of Commercial Debts (Interest) Act 1998 and 2002/2013 Regulations. The test suite is currently 100% green (354 passing tests) because existing tests verify `buildChasePrompt` with mock inputs where `clientBusinessName` is explicitly supplied and test `advanceEscalationStage` directly.

---

## 3. Caveats

- **No Live Cloudflare Email Sending in Local Environment**: `env.SEND.send` and `env.NOTIFY.send` are mocked in tests and dry-run bundled in build. Verification of live DKIM/SPF delivery requires staging or production environment with domain binding.
- **Gemini Live Key**: Tests use mock HTTP fetch responses for `generateContent`. Actual Gemini response quality with real API keys depends on external Google GenAI latency and availability; hence, introducing a deterministic offline fallback template is recommended.
- **Database Status Convention**: The schema uses `'escalated'` while types/specs frequently reference `'handed_back'`. This report assumes `'escalated'` is the canonical database column value for the terminal hand-back state unless a schema migration is approved.

---

## 4. Conclusion

Milestone M2's calculation engine (`statutory-interest.ts`) and prompt specifications (`gemini.ts`) are sound and legally compliant. However, Milestone M2 is not yet ready to be deemed fully finished due to two critical implementation defects and one architectural omission:
1. **Critical Defect**: In `backend/src/index.ts:839-851`, `inv.company_name` is omitted from `buildChasePrompt`, producing `[Client Business Name]` placeholders in Gemini chase drafts.
2. **Cadence Defect**: `runOverdueDetection` does not verify 7-day intervals between successive chases (`daysSinceChase >= 7`) or check for existing pending drafts (`status = 'draft'`).
3. **Architectural Gap**: `backend/src/lib/chase-runner.ts` must be created to encapsulate the overdue detection and draft generation loop.

All necessary modifications are scoped, isolated, and documented with exact proposed code changes in `report.md`.

---

## 5. Verification Method

1. **TypeScript Type Verification**:
   ```bash
   npx tsc --noEmit
   ```
   *Expected: Exit code 0, 0 errors.*

2. **Automated Unit & E2E Test Suite**:
   ```bash
   npm test
   ```
   *Expected: 354+ tests pass across all test suites.*

3. **Cloudflare Worker Dry-Run Bundle**:
   ```bash
   npm run build
   ```
   *Expected: Clean dry-run bundle without packaging errors.*

4. **Local D1 Database Migration Status**:
   ```bash
   npx wrangler d1 migrations list invoice-rescue-db --local
   ```
   *Expected: "No migrations to apply!"*

5. **Prompt Parameter Verification**:
   Inspect `backend/src/index.ts:839-851` and verify whether `clientBusinessName: inv.company_name` is passed. If missing, prompts output `[Client Business Name]`.
