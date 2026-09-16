## 2026-09-16T08:03:03Z

You are the Portal & Review Queue API Explorer for Milestone M3 (Client Portal & Review Queue - R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- backend/src/index.ts
- backend/src/lib/portal.ts
- backend/src/lib/admin.ts
- backend/src/lib/tenant-repo.ts
- backend/src/lib/chase-runner.ts

Mission:
1. Investigate the backend API requirements for Milestone M3 (R3):
   - `GET /api/portal/dashboard-data`: Returns executive overview metrics (overdue totals in pence, aging breakdown gauge: 1-7d, 8-14d, 15-21d, 22d+, active recovery pipeline count and amount, recent activity feed). Scoped by authenticated client session or default client.
   - `GET /api/portal/debtors`: Returns debtor ledger list with filtering by stage (`stage_1` to `stage_4`), status (`overdue`, `promised`, `paid`, `disputed`), multi-column sorting (amount, due date, days overdue), and debounced search matching debtor name, invoice number, or email.
   - `GET /api/admin/drafts` (or `GET /api/chase/queue`): Returns unapproved drafts from `chase_log` (`status = 'draft'`) with invoice details, recipient email, stage, and full statutory claim financial breakdown (principal, days overdue, statutory interest pence, fixed compensation pence, total claim pence).
   - `POST /api/admin/drafts/:id/approve` (or `POST /api/chase/:id/approve`): Approves draft, sends email via `env.SEND` (locked sender `hello@invoicerescue.co.uk`, signed by Tibor Rames on behalf of client), records sent timestamp, updates status to `'sent'`, and creates activity log.
   - `POST /api/admin/drafts/:id/skip` (or `POST /api/chase/:id/skip`): Defers/skips draft, updates status in `chase_log` to `'skipped'`.
   - `PUT /api/admin/drafts/:id`: Updates draft text in `chase_log` (`body` / `custom_message`).
2. Analyze how to implement these cleanly in `backend/src/index.ts` or `backend/src/lib/portal-api.ts` with zero external runtime dependencies.
3. Design exact URL patterns, query parameters, request/response JSON contracts, error statuses (401, 404, 400), and test strategies for Node test runner in `tests/portal-endpoints.test.ts`.
4. Write your detailed analysis to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api\report.md and a concise 5-component handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api\handoff.md.
5. Send completion message to parent when done.

Rules:
- DO NOT modify source code files. Exploration only.
- Write metadata only to your assigned directory.
