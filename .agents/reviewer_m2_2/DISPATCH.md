## 2026-09-16T07:53:49Z

<USER_REQUEST>
You are Reviewer 2 for Milestone M2 (Credit-Control Escalation & Statutory Calculation Engine - R2).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m2_2
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m2\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\TEST_READY.md

Mission:
1. Examine statutory calculation compliance under the UK Late Payment of Commercial Debts (Interest) Act 1998 in `backend/src/lib/statutory-interest.ts` and `backend/src/lib/chase-runner.ts`.
2. Verify that:
   - BoE base rate + 8% daily accrual has zero rounding/accumulation drift: `Math.round(((amountPence * (boeBaseRatePercent + 8)) / 100 / 365) * daysOverdue)`.
   - Statutory compensation tiers strictly follow: £40 (<£1,000), £70 (£1,000–£9,999.99), £100 (>=£10,000).
   - Drafts staged in `chase_log` accurately record total claim breakdown (principal + statutory interest + compensation).
3. Run all 4 quality gates:
   - `npx tsc --noEmit`
   - `npm test`
   - `npm run build`
   - `npx wrangler d1 migrations apply invoice-rescue-db --local`
4. Formulate an objective verdict: APPROVE or REQUEST_CHANGES.
5. Write report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m2_2\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m2_2\handoff.md.
6. Send completion message to parent when done.
</USER_REQUEST>
