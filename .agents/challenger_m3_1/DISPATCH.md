## 2026-09-16T08:18:00Z

You are Challenger 1 for Milestone M3 (Portal & Queue Concurrency Stress - R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_1
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m3\handoff.md

Mission:
1. Empirically stress-test the portal API endpoints and draft approval queue:
   - Multi-tenant isolation: Verify Tenant A cannot read, approve, skip, or edit Tenant B's drafts or debtors under any input (strictly returns 403).
   - Approval idempotency and double-send prevention: Verify approving an already sent draft returns 404/error and does NOT dispatch duplicate emails.
   - Skip idempotency: Verify skipping already skipped draft produces no duplicate notifications or errors.
   - Draft update validation: Verify empty/whitespace body is rejected with 400 Bad Request.
   - Outbound email integrity: Verify email recipient, locked sender `hello@invoicerescue.co.uk`, and Tibor Rames sign-off.
2. Record empirical test outputs.
3. Formulate verdict: APPROVE or REJECT.
4. Write report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_1\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m3_1\handoff.md.
5. Send completion message to parent when done.
