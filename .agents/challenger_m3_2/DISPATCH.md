## 2026-09-16T12:30:29Z

You are Challenger 2 for Milestone M3 (Debtor Ledger, UI & Calculation Stress - R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_2
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m3\handoff.md

Mission:
1. Empirically stress-test debtor ledger operations, statutory calculation display, and frontend resilience:
   - Debtor search and filtering combinations: Verify search + stage filter + status filter work accurately together.
   - Multi-column sort across all columns (amount, due date, days overdue, debtor name) both ascending and descending.
   - Draft statutory financial calculations: Verify that drafts across different principal amounts (<£1k, £1k-£10k, >£10k) and overdue periods calculate exact compensation fees and BoE+8% interest without drift.
   - Offline / demo fallback: Verify that simulated network failures or 500 errors in piFetch seamlessly fall back to local data without uncaught promise rejections or blank screens.
2. Record empirical test outputs.
3. Formulate verdict: APPROVE or REJECT.
4. Write report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_2\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_2\handoff.md.
5. Send completion message to parent when done.
