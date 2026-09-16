# Project: Invoice Rescue — B2B Credit-Control SaaS

## Architecture
- **Runtime**: Cloudflare Workers edge runtime (`compatibility_date: 2026-07-15`, `nodejs_compat`).
- **Zero Runtime Dependencies**: Standard Web APIs (`fetch`, `crypto.subtle`, `Response`, `Request`).
- **Database**: Cloudflare D1 SQLite (`invoice-rescue-db`) with strictly isolated tenant schemas.
- **Frontend**: Cloudflare Pages / Worker-served executive dashboard, debtor ledger, and review queue with dark/light modes and WCAG 2.2 Level AA compliance.
- **Email Delivery**: Split-trust routing via Cloudflare Worker `send_email` bindings:
  - `NOTIFY`: Operator-only inbox alerts (`tiborcc2@gmail.com`).
  - `SEND`: Debtor and client outbound communications (`hello@invoicerescue.co.uk`).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Multi-Tenant Data Isolation | Row-level `client_id` query scoping and `UNIQUE (client_id, invoice_number)` constraint | M1 (DONE) | Survey & R1 |
| 2 | OAuth 2.0 Connection Lifecycle | Connect, callback, refresh, and disconnect for Xero and QuickBooks | M1 (DONE) | Survey & R1 |
| 3 | Token Encryption at Rest | Web Crypto AES-GCM (256-bit) with random 12-byte IV for access/refresh tokens | M1 (DONE) | Survey & R1 |
| 4 | Webhook Cryptographic Verification | HMAC-SHA256 signature verification for Xero (`x-xero-signature`) and QuickBooks (`intuit-signature`) with `timingSafeEqual` | M1 (DONE) | Survey & R1 |
| 5 | Webhook Deduplication & Idempotency | Event deduplication via `accounting_webhook_events` before applying side effects | M1 (DONE) | Survey & R1 |
| 6 | Automated Accounting Ingestion | `SyncService` to fetch and reconcile unpaid debtor invoices into D1 | M1 (DONE) | Survey & R1 |
| 7 | Daily Ingestion Polling Job | Cron scheduled trigger to poll accounting providers for invoice updates | M1 (DONE) | Survey & R1 |
| 8 | 4-Stage Escalation Cadence | State machine transitioning Gentle (Day 1+), Follow-up (Day 8+), Firm (Day 15+), Final (Day 22+) | M2 (DONE) | Survey & R2 |
| 9 | Terminal Escalation States | Invoices in `paid` or `handed_back` receive no automated chases | M2 (DONE) | Survey & R2 |
| 10 | BoE Base Rate + 8% Statutory Interest | Accurate daily interest calculation `(Principal * (BaseRate + 8) / 100 / 365) * Days` with zero drift | M2 (DONE) | Survey & R2 |
| 11 | Statutory Compensation Tiers | £40 (<£1,000), £70 (£1,000–£9,999.99), £100 (≥£10,000) per UK Late Payment Act 1998 | M2 (DONE) | Survey & R2 |
| 12 | Locked Sender & Sign-off Model | Strict sender `hello@invoicerescue.co.uk` signed by Tibor Rames on behalf of client | M2 (DONE) | Survey & R2 |
| 13 | Chase Draft Generation | Generation and staging of stage-specific chase notices in `chase_log` with claim breakdown | M2 (DONE) | Survey & R2 |
| 14 | Executive Financial Dashboard | Overdue totals, aging breakdown gauge (1-7d, 8-14d, 15-21d, 22d+), and recovery pipeline | M3 (DONE) | Survey & R3 |
| 15 | Debtor Ledger Table | Debounced search (150ms), stage/status filtering, and multi-column sorting | M3 (DONE) | Survey & R3 |
| 16 | WCAG 2.2 AA Accessibility | Semantic HTML, skip links, 15:1+ contrast ratios, ARIA live regions, keyboard navigation | M3 (DONE) | Survey & R3 |
| 17 | Human-in-the-Loop Review Queue | Interactive draft approval queue displaying statutory calculations, editable draft text | M3 (DONE) | Survey & R3 |
| 18 | Queue Approval & Defer Actions | Functional "Approve & Send" and "Skip/Defer" actions with status updates | M3 (DONE) | Survey & R3 |
| 19 | Responsive & Theming Support | Mobile/desktop layouts and persistent dark/light theme switching | M3 (DONE) | Survey & R3 |
| 20 | Edge Runtime Zero External Deps | 100% Worker edge native runtime compatibility with zero external runtime packages | M4 (DONE) | Survey & R4 |
| 21 | Split-Trust Email Routing | Enforced separation between `NOTIFY` operator alerts and `SEND` debtor communications | M4 (DONE) | Survey & R4 |
| 22 | D1 Local & Remote Migration Integrity | Clean application of D1 migrations without schema drift or data corruption | M4 (DONE) | Survey & R4 |
| 23 | E2E Test Suite Pass (Tiers 1-4) | 100% passing opaque-box requirement tests covering all features | M5 (DONE) | Survey & AC |
| 24 | Adversarial Coverage Hardening (Tier 5) | White-box stress-testing, boundary probing, and zero-defect assurance | M5 (DONE) | Survey & AC |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Multi-Tenant Data & Accounting Sync | Tenant isolation, OAuth 2.0 lifecycle, AES-GCM token encryption, HMAC webhooks, idempotent sync service, daily sync cron | none | DONE |
| M2 | Escalation & Statutory Calculation Engine | 4-stage cadence, terminal state isolation, statutory interest BoE+8%, statutory compensation tiers, locked sender drafts | M1 | DONE |
| M3 | Client Portal & Review Queue | Dashboard, accessible debtor ledger (WCAG 2.2 AA), draft approval queue with in-place edits and send/defer | M1, M2 | DONE |
| M4 | Edge Infrastructure & Deliverability | Zero runtime deps, split-trust email routing, D1 migrations validation, edge security | M1, M2, M3 | DONE |
| M5 | Final Milestone (E2E 100% Pass & Hardening) | Phase 1: Pass 100% of E2E test suite (Tiers 1-4); Phase 2: Adversarial coverage hardening (Tier 5) | M1, M2, M3, M4, TEST_READY | DONE |

## Interface Contracts

### 1. Tenant Data & Repository Isolation (`tenant-repo`)
- `getTenantInvoices(db: D1Database, clientId: number): Promise<Invoice[]>`
- `getTenantInvoiceByNumber(db: D1Database, clientId: number, invoiceNumber: string): Promise<Invoice | null>`
- `upsertTenantInvoice(db: D1Database, clientId: number, invoice: InvoiceInput): Promise<void>`
- `recordAccountingWebhook(db: D1Database, eventId: string, provider: 'xero' | 'quickbooks', payload: unknown): Promise<boolean>` (returns false if duplicate)

### 2. Accounting Synchronization (`oauth-sync`)
- `GET /api/oauth/:provider/connect?client_id=...` -> Redirect to provider auth URL with state
- `GET /api/oauth/:provider/callback?code=...&state=...` -> Exchange code for tokens, encrypt with AES-GCM, store in `accounting_connections`
- `POST /api/webhooks/xero` -> Validate `x-xero-signature`, deduplicate, sync invoice changes
- `POST /api/webhooks/quickbooks` -> Validate `intuit-signature`, deduplicate, sync invoice changes
- `syncInvoices(db: D1Database, env: Env, clientId: number): Promise<SyncResult>`

### 3. Statutory Calculation Engine (`statutory-engine`)
- `statutoryInterestPence(amountPence: number, daysOverdue: number, boeBaseRatePercent: number): number`
  Formula: `Math.round(((amountPence * (boeBaseRatePercent + 8)) / 100 / 365) * daysOverdue)`
- `fixedCompensationPence(amountPence: number): number`
  `< 100_000` (under £1,000) -> `4000` (£40)
  `< 1_000_000` (£1,000 to £9,999.99) -> `7000` (£70)
  `>= 1_000_000` (£10,000+) -> `10000` (£100)
- `calculateCadenceStage(daysOverdue: number): EscalationStage`
  `daysOverdue < 1`: current
  `daysOverdue 1..7`: stage_1 (Gentle)
  `daysOverdue 8..14`: stage_2 (Follow-up)
  `daysOverdue 15..21`: stage_3 (Firm)
  `daysOverdue >= 22`: stage_4 (Final)

### 4. Client Portal & Draft Review API (`portal-api`)
- `GET /api/portal/dashboard-data` -> `{ overdueTotals, agingBreakdown, pipeline, recentActivity }` (scoped by session client)
- `GET /api/portal/debtors` -> `{ debtors: DebtorLedgerItem[] }` with filtering, sorting, pagination
- `GET /api/admin/drafts` -> `{ drafts: DraftItem[] }` with full statutory calculation breakdown
- `POST /api/admin/drafts/:id/approve` -> Updates draft status to `approved`, sends via `env.SEND`
- `POST /api/admin/drafts/:id/skip` -> Updates draft status to `skipped` / deferred
- `PUT /api/admin/drafts/:id` -> Updates draft message text

### 5. Email Deliverability & Split-Trust (`deliverability`)
- `sendOperatorNotification(env: Env, subject: string, body: string): Promise<void>` -> uses `env.NOTIFY`
- `sendDebtorCommunication(env: Env, to: string, subject: string, body: string): Promise<void>` -> uses `env.SEND` with sender `hello@invoicerescue.co.uk`, sign-off Tibor Rames on behalf of client

## Code Layout
- `backend/src/index.ts`: Worker entry point, route dispatch, scheduled cron handler
- `backend/src/lib/integrations/`:
  - `oauth-manager.ts`: OAuth 2.0 flows, token exchange, AES-GCM Web Crypto encryption
  - `webhooks.ts`: HMAC signature verification, constant-time validation
  - `sync-service.ts`: Accounting provider invoice ingestion and reconciliation
- `backend/src/lib/`:
  - `tenant-repo.ts`: Strict tenant query isolation, atomic upsert, error boundaries
  - `statutory-interest.ts`: BoE + 8% daily accrual and statutory compensation fee tiers
  - `escalation.ts`: 4-stage cadence logic and state transitions
  - `email.ts`: Split-trust email delivery routines (`NOTIFY` vs `SEND`)
  - `portal.ts`: Portal data routes and authenticated sessions
  - `admin.ts`: Review queue endpoints and draft approval/rejection actions
  - `db.ts`: Tenant-scoped query helpers and D1 data access facade
- `backend/db/migrations/`: D1 schema migrations (`0001` through `0007_query_indices.sql`)
- `frontend/dashboard/`: Client portal web assets (`index.html`, `debtors.html`, `approval-queue.html`, `dashboard.css`, `dashboard.js`)
- `tests/`: Automated test suites across all tiers (570 passing tests: 249 E2E Tiers 1-4, 51 Tier 5 adversarial, unit & integration suites)
