# Handoff Report: Milestone M3 Portal & Review Queue Backend API

**Author:** Portal & Review Queue API Explorer  
**Working Directory:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api`  
**Target Milestone:** Milestone M3 (Client Portal & Review Queue - R3)  
**Date:** 2026-09-16  

---

## 1. Observation

1. **Current Route Mapping (`backend/src/index.ts:260-273`)**:
   ```ts
   if (request.method === "GET" && path === "/admin") {
     return requireAdminAuth(request, env) ?? (await handleAdminReviewQueue(env));
   }
   const approveMatch = path.match(/^\/api\/chase\/(\d+)\/approve$/);
   if (request.method === "POST" && approveMatch) {
     return requireAdminAuth(request, env) ?? (await handleChaseApprove(request, env, approveMatch[1]));
   }
   const skipMatch = path.match(/^\/api\/chase\/(\d+)\/skip$/);
   if (request.method === "POST" && skipMatch) {
     return requireAdminAuth(request, env) ?? (await handleChaseSkip(request, env, skipMatch[1]));
   }
   ```
   - Only `/api/chase/:id/approve` and `/api/chase/:id/skip` exist.
   - Route `/api/admin/drafts` (or `/api/chase/queue`), `POST /api/admin/drafts/:id/approve`, `POST /api/admin/drafts/:id/skip`, `PUT /api/admin/drafts/:id`, `GET /api/portal/dashboard-data`, and `GET /api/portal/debtors` do not yet exist in `backend/src/index.ts`.
   - In `handleChaseApprove` (`backend/src/index.ts:543-548`), only `application/x-www-form-urlencoded` and `multipart/form-data` are checked. JSON payloads are ignored.

2. **Frontend Review Queue & Debtor Ledger (`frontend/dashboard/js/dashboard.js:1070-1082, 1120-1126`)**:
   - The interactive frontend already implements "Approve & Send" calls to `/api/chase/${id}/approve` with `Content-Type: application/x-www-form-urlencoded` and "Skip" calls to `/api/chase/${id}/skip`.
   - The frontend expects exact statutory calculations: fixed compensation tiers (£40/£70/£100) and BoE base rate + 8% daily simple interest (`dashboard.js:321-330`).
   - Mock data currently populates the executive dashboard and debtor table via `sessionStorage`.

3. **Database Schema & Constraints (`backend/db/migrations/0003_add_check_constraints.sql:58-87`)**:
   - `invoices` contains `id`, `client_id`, `debtor_name`, `debtor_email`, `invoice_number`, `amount_pence`, `currency`, `issued_date`, `due_date`, `status` (`'overdue' | 'promised' | 'disputed' | 'paid' | 'escalated'`), `paid_date`, `created_at`, `external_id`, `last_synced_at`.
   - `chase_log` contains `id`, `invoice_id`, `step`, `channel`, `subject`, `outcome` (`'sent' | 'replied' | 'promised' | 'paid' | 'bounced'`), `sent_at`, `body`, `status` (`'draft' | 'sent' | 'skipped'`), `reviewed_at`, `reviewed_by`.

4. **Multi-Tenant Isolation Layer (`backend/src/lib/tenant-repo.ts:384-449`)**:
   - Functional helpers `getTenantDrafts`, `approveTenantDraft`, `skipTenantDraft` strictly constrain queries using `WHERE i.client_id = ?1`.

5. **Existing Verification Baselines**:
   - `npm test`: 376 tests passing (duration ~6.1s).
   - `npx tsc --noEmit`: 0 TypeScript compiler errors.
   - `npm run build`: `wrangler deploy --dry-run` bundles cleanly with 0 errors.

---

## 2. Logic Chain

1. From **Observation 1**, `backend/src/index.ts` lacks the endpoints specified in Milestone M3 (`GET /api/portal/dashboard-data`, `GET /api/portal/debtors`, `GET /api/admin/drafts`, `PUT /api/admin/drafts/:id`, and the `/api/admin/drafts/:id/*` aliases).
2. From **Observation 2**, the existing client portal (`frontend/dashboard/`) expects JSON data matching the statutory formula, stage cadences (Stages 1-4), and debtor fields. Providing these endpoints allows seamless live hydration while preserving fallback capabilities.
3. From **Observation 1 & 4**, while admin routes currently authenticate via HTTP Basic Auth (`requireAdminAuth`), client portal requests can be authenticated via `portal_session` cookies or bearer tokens (`authenticateClient`), or fall back to the default active client for demo mode.
4. From **Observation 3**, SQLite functions `julianday('now') - julianday(due_date)` allow accurate, zero-drift `days_overdue` and `stage` derivation without adding schema columns.
5. Encapsulating these six endpoints within a new module `backend/src/lib/portal-api.ts` (with route delegates in `backend/src/index.ts`) ensures separation of concerns, zero external runtime dependencies, and strict tenant boundary validation.

---

## 3. Caveats

1. **Session Cookie Path**: `backend/src/lib/portal-auth.ts` issues `portal_session` cookies with `Path=/portal`. When calling `/api/portal/*` from browser JavaScript, browsers do not attach `Path=/portal` cookies unless the request includes a Bearer header or the cookie path is broadened to `/`. Both Bearer token authorization and default client fallback are designed to handle this seamlessly.
2. **Demo Mode Fallback**: When unauthenticated, the endpoints default to the first active client (`status = 'active'`). In production behind Cloudflare Access, strict 401 rejection can be toggled without changing the endpoint contracts.
3. **No External Libraries**: All computations, query parsing, and response formatting rely solely on Web APIs and D1 SQL to maintain the strict zero external dependencies requirement.

---

## 4. Conclusion

1. Implement `backend/src/lib/portal-api.ts` exporting:
   - `handlePortalDashboardData(request: Request, env: Env): Promise<Response>`
   - `handlePortalDebtors(request: Request, env: Env): Promise<Response>`
   - `handleGetDrafts(request: Request, env: Env): Promise<Response>`
   - `handleApproveDraft(request: Request, env: Env, draftId: string): Promise<Response>`
   - `handleSkipDraft(request: Request, env: Env, draftId: string): Promise<Response>`
   - `handleUpdateDraft(request: Request, env: Env, draftId: string): Promise<Response>`
2. Mount the routes in `backend/src/index.ts` under:
   - `GET /api/portal/dashboard-data`
   - `GET /api/portal/debtors`
   - `GET /api/admin/drafts` & `GET /api/chase/queue`
   - `POST /api/admin/drafts/:id/approve` & `POST /api/chase/:id/approve`
   - `POST /api/admin/drafts/:id/skip` & `POST /api/chase/:id/skip`
   - `PUT /api/admin/drafts/:id` & `PUT /api/chase/:id`
3. Enforce the locked sender model (`hello@invoicerescue.co.uk`) and sign-off by Tibor Rames on behalf of the client for all approved drafts.
4. Implement a dedicated test suite in `tests/portal-endpoints.test.ts` covering all 6 endpoints across 28 distinct test cases.

---

## 5. Verification Method

To independently verify the architecture and readiness:
1. **Inspect Report & Architecture**:
   - Review `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api\report.md` for full query definitions, JSON contracts, and error conditions.
2. **Verify Typecheck**:
   ```powershell
   npx tsc --noEmit
   ```
   Must pass with 0 errors.
3. **Verify Existing Tests**:
   ```powershell
   npm test
   ```
   Must execute and pass all 376 tests.
4. **Verify Dry-Run Worker Build**:
   ```powershell
   npm run build
   ```
   Must exit with code 0.
5. **Invalidation Conditions**:
   - Any modification introducing external packages to `dependencies` in `package.json` violates the zero-dependency rule.
   - Any query omitting `client_id` parameter binding violates multi-tenant isolation.
