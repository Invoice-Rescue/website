<!-- Generated: 2026-09-14 | Files scanned: 31 | Token estimate: ~850 -->
# Backend Codemap

## Router & Middleware Chain

`backend/src/index.ts` is the single Cloudflare Worker entry point routing requests via standard `fetch(request, env, ctx)`:

```text
Request ──> Parse Method & Path
                 │
                 ├── /api/health ─────────────────> Health Check & D1 Connectivity Probe
                 ├── /api/statutory-rate ─────────> Current BoE Base Rate
                 ├── POST /api/lead ──────────────> Schema Validation ──> D1 Insert ──> env.NOTIFY Alert
                 ├── POST /api/billing/webhook ───> Stripe Signature Guard ──> Sync clients.status
                 │
                 ├── /admin & /api/chase/* ───────> requireAdminAuth() [Basic Auth: ADMIN_SECRET]
                 │        ├── GET /admin ─────────> renderReviewQueue()
                 │        ├── POST /api/clients ──> Create Client + Stripe Customer Provision
                 │        ├── POST /api/clients/:id/invoices/import ──> parseCsv() ──> D1 Bulk Insert
                 │        ├── POST /api/chase/:id/approve ───────────> env.SEND Dispatch ──> Mark 'sent'
                 │        └── POST /api/chase/:id/skip ──────────────> Mark 'skipped'
                 │
                 └── /portal/* ───────────────────> authenticateClient() [HMAC-SHA256 Cookie]
                          ├── GET /portal ────────> renderPortalLogin()
                          ├── POST /portal/login ─> Generate Token ──> env.SEND Magic Link
                          ├── GET /portal/verify ─> Validate HMAC ──> Set HttpOnly Session Cookie
                          ├── GET /portal/dashboard ──> Scoped Invoices Query ──> renderClientPortal()
                          ├── POST /portal/billing ───> Stripe Billing Portal Session ──> Redirect
                          └── POST /portal/logout ────> Clear Session Cookie
```

## Scheduled Cron Triggers

Defined in `wrangler.jsonc` (`triggers.crons`):

- `0 6 * * *` (`06:00 UTC` daily) ➔ `detect-overdue`: Detects unpaid invoices past due date, calculates next step via `nextStepDue()`, drafts email via Gemini, and stages draft in `chase_log`.
- `0 8 * * FRI` (`08:00 UTC` Fri) ➔ `friday-report`: Compiles weekly recovered cash vs outstanding debt digest and dispatches client emails.

## Key Modules & Responsibilities

| File | Lines | Primary Responsibility & Key Functions |
| --- | --- | --- |
| [`backend/src/index.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/index.ts) | ~859 | HTTP router, Basic Auth/Session guards, cron triggers, email handler |
| [`backend/src/lib/statutory-interest.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/statutory-interest.ts) | ~40 | `statutoryInterestPence()`, `fixedCompensationPence()` (Late Payment Act) |
| [`backend/src/lib/escalation.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/escalation.ts) | ~56 | `nextStepDue()`, `STEP_LABELS` (Step 1: +7d, Step 2: +14d, Step 3: +21d) |
| [`backend/src/lib/gemini.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/gemini.ts) | ~87 | `buildChasePrompt()`, `draftChaseMessage()` (Gemini REST API caller) |
| [`backend/src/lib/portal-auth.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/portal-auth.ts) | ~150 | `createMagicToken()`, `verifyMagicToken()`, `createSessionCookie()`, `authenticateClient()` |
| [`backend/src/lib/stripe.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/stripe.ts) | ~135 | `createCustomer()`, `createPortalSession()`, `verifyWebhookSignature()` |
| [`backend/src/lib/csv.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/csv.ts) | ~85 | `parseCsv()` — RFC-4180 compliant CSV parser with quote escaping |
| [`backend/src/lib/admin.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/admin.ts) | ~110 | `renderReviewQueue()` — Server-rendered HTML review queue for staged drafts |
| [`backend/src/lib/portal.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/portal.ts) | ~140 | `renderPortalLogin()`, `renderClientPortal()` — Client dashboard UI |
