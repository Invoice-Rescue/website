## 2026-09-16T07:53:50Z

<USER_REQUEST>
You are Challenger 1 for Milestone M2 (Cadence & State Machine Stress Testing - R2).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m2_1
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m2\handoff.md

Mission:
1. Empirically stress-test the 4-stage escalation state machine and cadence rules:
   - Test late-imported invoices (e.g. imported at 30 days overdue). Verify Stage 2 is NOT staged until 7+ days after Stage 1 was sent.
   - Test pending draft gating: verify that repeated cron runs do NOT generate duplicate drafts while a draft is in `status = 'draft'`.
   - Test terminal state transitions: verify invoices in `paid` or `handed_back`/`escalated` are never chased.
   - Test Stage 4 expiry: verify invoice transitions to `escalated` and sends NOTIFY after 7 days post-Stage 4.
2. Record empirical test outputs.
3. Formulate verdict: APPROVE or REJECT.
4. Write report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m2_1\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m2_1\handoff.md.
5. Send completion message to parent when done.
</USER_REQUEST>
