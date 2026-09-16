## 2026-09-16T05:17:07Z
You are the Implementation Worker for Milestone M1 (Multi-Tenant Data Architecture & Accounting Synchronization - R1).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m1
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory input documents to read before writing code:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_tenancy_db\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_oauth_routes\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_webhooks_sync\report.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Exclusive Write Ownership:
- backend/src/lib/tenant-repo.ts
- backend/src/lib/db.ts
- backend/src/lib/integrations/oauth-manager.ts
- backend/src/lib/integrations/sync-service.ts
- backend/src/index.ts
- tests/tenant-repo.test.ts
- tests/sync-service.test.ts
- tests/oauth-endpoints.test.ts

Mission & Implementation Requirements:
1. Implement the tenant-isolated data repository layer (e.g. backend/src/lib/tenant-repo.ts):
   - Strict `client_id` query scoping on all operations (getTenantInvoices, getTenantInvoiceByNumber, upsertTenantInvoice, recordAccountingWebhook).
   - Atomic upsert query using `INSERT ... ON CONFLICT(client_id, invoice_number) DO UPDATE` to prevent crashes on re-imports and respect existing status.
   - Comprehensive error types (TenantBoundaryViolationError, InvalidTenantError).
2. Implement zero-dependency OAuth 2.0 connection endpoints in backend/src/index.ts & oauth-manager.ts:
   - `GET /api/oauth/:provider/connect` (secure HMAC state, redirect to provider auth URL)
   - `GET /api/oauth/:provider/callback` (validate state, exchange code, encrypt tokens with AES-GCM 256-bit, store in `accounting_connections`)
   - `POST /api/oauth/:provider/refresh`
   - `POST /api/oauth/:provider/disconnect`
   - Zero external runtime dependencies (use Web Crypto API and native fetch). Support CI/offline mock flow.
3. Implement cryptographic webhook handlers and SyncService in backend/src/index.ts & sync-service.ts:
   - `POST /api/webhooks/xero`: verify HMAC signature via `verifyXeroWebhook` (return HTTP 401 on invalid signature for Xero Intent to Receive compliance; HTTP 200 on valid), deduplicate events via `accounting_webhook_events`, sync invoice updates.
   - `POST /api/webhooks/quickbooks`: verify HMAC signature via `verifyQuickBooksWebhook`, deduplicate events, sync invoice updates.
   - `SyncService`: fetch invoices from accounting provider, deduplicate/reconcile into D1, mark settled invoices as 'paid', and cancel pending drafts in `chase_log` ('skipped').
   - Scheduled cron handler: add accounting provider sync before `runOverdueDetection` at 06:00 UTC.
4. Comprehensive Automated Tests:
   - Write thorough unit and integration tests in tests/ (e.g. tests/tenant-repo.test.ts, tests/sync-service.test.ts, tests/oauth-endpoints.test.ts).
   - Guarantee existing 31 tests continue to pass.
5. Verification & Quality Gates:
   - Run `npx tsc --noEmit` -> must pass with 0 errors.
   - Run `npm test` -> must pass 100%.
   - Run `npm run build` -> must bundle cleanly with zero external runtime dependencies.
   - Run `npx wrangler d1 migrations apply invoice-rescue-db --local` -> must succeed.
6. Handoff:
   - Write detailed handoff report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m1\handoff.md documenting all changes, verification commands, and full test outputs.
   - Send completion message to parent when done.
