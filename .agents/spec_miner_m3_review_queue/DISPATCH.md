## 2026-09-16T08:03:03Z

<USER_REQUEST>
You are the Review Queue & Statutory Display Spec Miner for Milestone M3 (R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_m3_review_queue
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- frontend/dashboard/approval-queue.html
- backend/src/lib/statutory-interest.ts
- backend/src/lib/chase-runner.ts

Mission:
1. Read ORIGINAL_REQUEST.md carefully regarding Requirement R3 and Acceptance Criteria:
   - "Draft approval queue displays full statutory financial calculations, editable draft text, and functional 'Approve & Send' and 'Skip/Defer' actions."
2. Mine the exact functional, UI, and data specifications for the human-in-the-loop review queue:
   - Financial ribbon calculations per draft: Principal debt, days overdue, statutory interest (Bank of England base rate + 8% daily simple accrual), statutory compensation fee (£40 for <£1k, £70 for £1k-£9,999.99, £100 for >=£10k), and total claim owed.
   - Locked sender identity display: `hello@invoicerescue.co.uk`, signed by Tibor Rames on behalf of client.
   - In-place draft editing: textarea interaction, character count, save action, body update in D1 `chase_log`.
   - "Approve & Send" interaction: POST to approve endpoint, trigger `env.SEND.send()`, transition draft status to `'sent'`, update UI queue count, add activity log item.
   - "Skip/Defer" interaction: POST to skip endpoint, transition draft status to `'skipped'`, add activity log item.
   - Empty state messaging and alert banners.
3. Write detailed specification to d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_m3_review_queue\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_m3_review_queue\handoff.md.
4. Send completion message to parent when done.

Rules:
- DO NOT modify source code files. Specification mining only.
- Write metadata only to your assigned directory.
</USER_REQUEST>
