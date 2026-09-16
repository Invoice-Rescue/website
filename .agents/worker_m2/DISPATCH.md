## 2026-09-16T07:44:22Z
You are the Milestone M2 Implementation Worker (Credit-Control Escalation & Statutory Calculation Engine - R2).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m2
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read before coding:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m2\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m2\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Exclusive Write Ownership:
- backend/src/lib/chase-runner.ts
- backend/src/lib/escalation.ts
- backend/src/index.ts
- tests/chase-runner.test.ts

Mission & Implementation Requirements:
1. Create `backend/src/lib/chase-runner.ts`:
   - Encapsulate `runOverdueDetection(env: Env)` as a robust, exported function.
   - When calling `buildChasePrompt(...)`, pass `clientBusinessName: inv.company_name` so the generated drafts sign off on behalf of the genuine client business name (never falling back to `[Client Business Name]`).
   - Enforce the 7-day spacing between chases (`daysSinceChase >= 7` via `sent_at` or `advanceEscalationStage`) so invoices imported 15+ days overdue do not rapid-fire stages on successive days.
   - Enforce pending draft gating: if an invoice already has a row in `chase_log` with `status = 'draft'`, skip generating a new draft for it until the pending draft is reviewed/handled.
   - Enforce terminal state transition: if Stage 4 has been sent and 7+ days have passed without payment, transition `invoices.status = 'escalated'` and alert the operator via `env.NOTIFY`.
2. Update `backend/src/index.ts`:
   - Import and invoke `runOverdueDetection` from `backend/src/lib/chase-runner.ts` in `scheduled()`.
3. Add automated tests in `tests/chase-runner.test.ts`:
   - Verify `clientBusinessName` is passed and present in prompt.
   - Verify 7-day cadence spacing is strictly enforced.
   - Verify pending draft gating prevents duplicate drafts.
   - Verify terminal transition to `escalated` occurs after Stage 4.
4. Run all quality gates:
   - `npx tsc --noEmit` -> 0 errors.
   - `npm test` -> 100% passing.
   - `npm run build` -> clean dry run.
   - `npx wrangler d1 migrations apply invoice-rescue-db --local` -> clean.
5. Write detailed handoff report in d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m2\handoff.md documenting all code changes, test execution commands, and full test outputs.
6. Send completion message to parent when done.
