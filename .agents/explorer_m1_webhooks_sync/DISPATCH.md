## 2026-09-16T05:12:11Z

<USER_REQUEST>
You are the M1 Webhooks & Sync Explorer.
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_webhooks_sync
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_survey_backend\report.md

Mission:
1. Investigate webhook ingestion and accounting synchronization requirements for Milestone M1 (R1).
2. Design the cryptographic webhook router handlers:
   - `POST /api/webhooks/xero`: verifies `x-xero-signature` HMAC-SHA256, responds to ITR checks, deduplicates events via `accounting_webhook_events`, and syncs invoice updates.
   - `POST /api/webhooks/quickbooks`: verifies `intuit-signature` HMAC-SHA256, deduplicates events, and triggers invoice synchronization.
3. Design the `SyncService` implementation in `backend/src/lib/integrations/sync-service.ts` to fetch, deduplicate, and idempotently upsert unpaid invoices into D1, marking paid invoices appropriately.
4. Design the daily cron scheduled handler integration in `backend/src/index.ts` to poll accounting providers.
5. Write your report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_webhooks_sync\report.md and handoff.md.
6. Send a completion message to parent when done.

Rules:
- DO NOT modify or write source code files. Exploration and design recommendations only.
</USER_REQUEST>
