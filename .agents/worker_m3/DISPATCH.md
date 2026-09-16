## 2026-09-16T08:07:52Z

<USER_REQUEST>
You are the Milestone M3 Implementation Worker (Client Portal & Human-in-the-Loop Review Queue - R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m3
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory input documents to read before writing code:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_frontend_wiring\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_frontend_wiring\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_m3_review_queue\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_m3_review_queue\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Exclusive Write Ownership:
- backend/src/lib/portal-api.ts
- backend/src/index.ts
- frontend/dashboard/js/dashboard.js
- tests/portal-endpoints.test.ts

Mission & Implementation Requirements:
1. Implement backend portal and review queue module `backend/src/lib/portal-api.ts`:
   - `handlePortalDashboardData(request: Request, env: Env)`: Calculates executive metrics (`totalOverduePence`, `activeInChasePence`, `recoveredThisMonthPence`, `overdueCount`), 4-tier aging breakdown (1-7d, 8-14d, 15-21d, 22d+), recovery pipeline, and recent activity feed from `chase_log`.
   - `handlePortalDebtors(request: Request, env: Env)`: Returns filtered, multi-column sorted, paginated debtor ledger with debounced search matching debtor name, invoice number, or email.
   - `handleGetDrafts(request: Request, env: Env)`: Returns unapproved drafts (`status = 'draft'`) from `chase_log` with statutory calculation breakdown (`principalPence`, `compensationPence` £40/£70/£100, `statutoryInterestPence` BoE+8%, `totalClaimPence`).
   - `handleApproveDraft(request: Request, env: Env, draftId: string)`: Approves draft, accepts optional edited message body (via JSON or form urlencoded), dispatches outbound email via `env.SEND` locked to `hello@invoicerescue.co.uk` signed by Tibor Rames on behalf of client, updates status to `'sent'`, stamps `sent_at`, `reviewed_at`, `reviewed_by = 'Tibor Rames'`, updates invoice last contact, logs activity.
   - `handleSkipDraft(request: Request, env: Env, draftId: string)`: Defers draft, updates status to `'skipped'`, stamps `reviewed_at`, sends 0 emails.
   - `handleUpdateDraft(request: Request, env: Env, draftId: string)`: Updates draft body in `chase_log`.
   - Authenticate client via session cookie or bearer token, or fall back to default active client for demo mode. Ensure strict tenant isolation. Zero external runtime dependencies.
2. Mount the routes in `backend/src/index.ts`:
   - `GET /api/portal/dashboard-data`
   - `GET /api/portal/debtors`
   - `GET /api/admin/drafts` & `GET /api/chase/queue`
   - `POST /api/admin/drafts/:id/approve` & `POST /api/chase/:id/approve`
   - `POST /api/admin/drafts/:id/skip` & `POST /api/chase/:id/skip`
   - `PUT /api/admin/drafts/:id` & `PUT /api/chase/:id`
   - Support both JSON and URL-encoded bodies for approvals.
3. Enhance `frontend/dashboard/js/dashboard.js`:
   - Implement unified `apiFetch` that attempts live backend endpoints first, falling back smoothly to `sessionStorage` / seeded demo data on 401/404/network errors.
   - Wire dashboard metrics and aging gauge to `/api/portal/dashboard-data`.
   - Wire debtor ledger to `/api/portal/debtors`.
   - Wire draft approval queue to `/api/admin/drafts`, with in-place draft editing saving via `PUT /api/admin/drafts/:id` or local state, and approve/skip actions calling the respective endpoints.
   - Add WCAG 2.2 AA fixes: keyboard support (Enter/Space) on `th.sortable`, dynamic `aria-valuetext` on aging gauge, focus restoration after draft message editing.
   - Ensure instant debounced search (150ms), stage/status filtering, and dual-theme persistence (`invoice_rescue_theme`) operate flawlessly.
4. Comprehensive Automated Tests in `tests/portal-endpoints.test.ts`:
   - Test all 6 endpoints with realistic in-memory D1 data.
   - Test statutory calculation breakdown in draft queue.
   - Test approve and send with email mock verifying sender envelope and sign-off.
   - Test skip and update draft.
   - Test debtor search, filter by stage and status, and multi-column sort.
   - Test tenant isolation and 404 on non-existent draft.
5. Verification & Quality Gates:
   - Run `npx tsc --noEmit` -> 0 errors.
   - Run `npm test` -> 100% passing (all existing 376 tests + new portal tests).
   - Run `npm run build` -> clean dry-run bundle.
   - Run `npx wrangler d1 migrations apply invoice-rescue-db --local` -> clean.
6. Handoff:
   - Write detailed handoff report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m3\handoff.md documenting all changes, verification commands, and full test outputs.
   - Send completion message to parent when done.
</USER_REQUEST>
