# Portal & Review Queue API Analysis Report (Milestone M3 / R3)

**Author:** Portal & Review Queue API Explorer  
**Milestone:** M3 (Client Portal & Review Queue - R3)  
**Date:** 2026-09-16  
**Working Directory:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_portal_api`  
**Target Implementation:** `backend/src/lib/portal-api.ts`, `backend/src/index.ts`, `tests/portal-endpoints.test.ts`

---

## 1. Executive Summary

Milestone M3 (Client Portal & Human-in-the-Loop Review Queue) provides client operators and administrators with interactive credit-control visibility and controls. While static HTML/JS prototypes currently exist under `frontend/dashboard/` using `sessionStorage` mock data, the backend API endpoints must be fully implemented on the Cloudflare Workers edge runtime backed by Cloudflare D1 with **zero external runtime dependencies**.

This report establishes the complete architecture, data access patterns, exact JSON contracts, authentication logic, error handling, and test plans for the six required endpoints:
1. `GET /api/portal/dashboard-data`: Executive financial overview (overdue totals, aging breakdown gauge, active recovery pipeline, recent activity audit trail).
2. `GET /api/portal/debtors`: Debtor ledger list with filtering by stage/status, multi-column sorting, and debounced search.
3. `GET /api/admin/drafts` (and alias `GET /api/chase/queue`): Staged unapproved AI drafts with full statutory claim breakdowns (principal, days overdue, statutory interest BoE+8%, fixed compensation £40/£70/£100, total claim).
4. `POST /api/admin/drafts/:id/approve` (and alias `POST /api/chase/:id/approve`): Dispatches debtor email via `env.SEND` using locked sender `hello@invoicerescue.co.uk`, updates status to `'sent'`, records review timestamp and operator sign-off.
5. `POST /api/admin/drafts/:id/skip` (and alias `POST /api/chase/:id/skip`): Skips/defers draft, updating status to `'skipped'`.
6. `PUT /api/admin/drafts/:id` (and alias `PUT /api/chase/:id`): Updates draft message text in-place before sending.

---

## 2. Existing Codebase & Schema Architecture

### 2.1 Database Schema (D1 SQLite)
- **`clients`**:
  - `id` (INTEGER PRIMARY KEY)
  - `company_name` (TEXT)
  - `contact_name` (TEXT)
  - `contact_email` (TEXT)
  - `plan` (TEXT: `'foundation' | 'engine' | 'operator'`)
  - `status` (TEXT: `'onboarding' | 'active' | 'paused' | 'churned'`)
  - `accounting_source` (TEXT: `'xero' | 'quickbooks' | 'csv'`)
  - `stripe_customer_id` (TEXT)
  - `voice_notes` (TEXT)
- **`invoices`**:
  - `id` (INTEGER PRIMARY KEY)
  - `client_id` (INTEGER REFERENCES `clients(id)`)
  - `debtor_name` (TEXT)
  - `debtor_email` (TEXT)
  - `invoice_number` (TEXT)
  - `amount_pence` (INTEGER > 0)
  - `currency` (TEXT DEFAULT `'GBP'`)
  - `issued_date` (TEXT)
  - `due_date` (TEXT)
  - `status` (TEXT CHECK: `'overdue' | 'promised' | 'disputed' | 'paid' | 'escalated'`)
  - `paid_date` (TEXT)
  - `external_id` (TEXT)
  - `last_synced_at` (TEXT)
  - `UNIQUE (client_id, invoice_number)`
- **`chase_log`**:
  - `id` (INTEGER PRIMARY KEY)
  - `invoice_id` (INTEGER REFERENCES `invoices(id)`)
  - `step` (INTEGER: 1 to 4)
  - `channel` (TEXT DEFAULT `'email'`)
  - `subject` (TEXT)
  - `body` (TEXT)
  - `outcome` (TEXT: `'sent' | 'replied' | 'promised' | 'paid' | 'bounced'`)
  - `status` (TEXT CHECK: `'draft' | 'sent' | 'skipped'`)
  - `sent_at` (TEXT)
  - `reviewed_at` (TEXT)
  - `reviewed_by` (TEXT)

### 2.2 Existing Route Analysis (`backend/src/index.ts`)
- `requireAdminAuth(request, env)`: Checks HTTP Basic Auth with `ADMIN_SECRET`.
- `authenticateClient(request, env.PORTAL_SESSION_SECRET)`: Reads `portal_session` cookie and verifies HMAC-SHA256 token.
- Existing `/api/chase/:id/approve` and `/api/chase/:id/skip`:
  - Only support admin Basic Auth.
  - Only parse form-data/urlencoded bodies, failing to read JSON bodies.
  - Do not update `sent_at = datetime('now')` on approval (sent_at was set when draft was staged).
  - Do not support the `/api/admin/drafts/*` route paths or `PUT /api/admin/drafts/:id`.

---

## 3. Detailed Endpoint Specifications & Contracts

### 3.1 `GET /api/portal/dashboard-data`

#### Purpose
Provides executive overview metrics, aging distribution percentages, active recovery pipeline metrics, and recent activity events for the executive dashboard.

#### Routing & Auth
- **Path**: `GET /api/portal/dashboard-data`
- **Authentication**:
  1. Portal session cookie (`portal_session`) or Bearer token (`Authorization: Bearer <token>`).
  2. Admin Basic Auth (`Authorization: Basic <base64>`): optionally accepts `?client_id=X`.
  3. Demo Fallback: If unauthenticated, scopes to the primary active client (`SELECT id FROM clients WHERE status = 'active' ORDER BY id ASC LIMIT 1`). If no clients exist, returns clean zeroed metrics.
- **Security Rule**: An authenticated client cannot query another client's data by appending `?client_id=X`; session identity strictly overrides query parameters.

#### Data Aggregation Queries
```sql
-- 1. Financial Totals
SELECT
  COALESCE(SUM(CASE WHEN status IN ('overdue', 'promised', 'disputed', 'escalated') THEN amount_pence ELSE 0 END), 0) AS total_overdue_pence,
  COALESCE(SUM(CASE WHEN status IN ('overdue', 'promised', 'escalated') THEN amount_pence ELSE 0 END), 0) AS active_chase_pence,
  COALESCE(SUM(CASE WHEN status = 'paid' AND (paid_date >= date('now', '-30 days') OR paid_date IS NULL) THEN amount_pence ELSE 0 END), 0) AS recovered_month_pence,
  COALESCE(SUM(CASE WHEN status IN ('overdue', 'promised', 'disputed', 'escalated') THEN 1 ELSE 0 END), 0) AS overdue_count
FROM invoices
WHERE client_id = ?1;

-- 2. Aging Breakdown Buckets
SELECT
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) <= 7 THEN amount_pence ELSE 0 END), 0) AS b1_pence,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) <= 7 THEN 1 ELSE 0 END), 0) AS b1_count,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 7 AND (julianday('now') - julianday(due_date)) <= 14 THEN amount_pence ELSE 0 END), 0) AS b2_pence,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 7 AND (julianday('now') - julianday(due_date)) <= 14 THEN 1 ELSE 0 END), 0) AS b2_count,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 14 AND (julianday('now') - julianday(due_date)) <= 21 THEN amount_pence ELSE 0 END), 0) AS b3_pence,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 14 AND (julianday('now') - julianday(due_date)) <= 21 THEN 1 ELSE 0 END), 0) AS b3_count,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 21 THEN amount_pence ELSE 0 END), 0) AS b4_pence,
  COALESCE(SUM(CASE WHEN (julianday('now') - julianday(due_date)) > 21 THEN 1 ELSE 0 END), 0) AS b4_count
FROM invoices
WHERE client_id = ?1 AND status IN ('overdue', 'promised', 'disputed', 'escalated');

-- 3. Recent Activity (Outbound Chases + Paid Invoices)
SELECT
  'chase_' || cl.id AS id,
  CASE WHEN cl.status = 'sent' THEN 'sent' WHEN cl.status = 'draft' THEN 'draft' ELSE 'skipped' END AS type,
  CASE
    WHEN cl.status = 'sent' THEN 'Stage ' || cl.step || ' dispatched'
    WHEN cl.status = 'draft' THEN 'Stage ' || cl.step || ' draft staged'
    ELSE 'Stage ' || cl.step || ' skipped'
  END AS title,
  i.invoice_number || ' (' || i.debtor_name || ')' AS detail,
  i.amount_pence,
  i.currency,
  COALESCE(cl.reviewed_at, cl.sent_at) AS timestamp
FROM chase_log cl
JOIN invoices i ON i.id = cl.invoice_id
WHERE i.client_id = ?1
ORDER BY cl.sent_at DESC
LIMIT 10;
```

#### JSON Response Schema (200 OK)
```json
{
  "ok": true,
  "clientId": 1,
  "companyName": "Apex Studio Ltd",
  "plan": "engine",
  "metrics": {
    "totalOverduePence": 2355000,
    "activeChasingPence": 1835000,
    "recoveredMonthPence": 925000,
    "overdueCount": 6
  },
  "agingBreakdown": {
    "bucket1_to_7": { "amountPence": 375000, "count": 1, "percentage": 16 },
    "bucket8_to_14": { "amountPence": 640000, "count": 1, "percentage": 27 },
    "bucket15_to_21": { "amountPence": 890000, "count": 1, "percentage": 38 },
    "bucket22_plus": { "amountPence": 450000, "count": 3, "percentage": 19 }
  },
  "pipeline": {
    "count": 6,
    "amountPence": 1835000
  },
  "recentActivity": [
    {
      "id": "chase_102",
      "type": "sent",
      "title": "Stage 2 Follow-up dispatched",
      "detail": "INV-2026-104 (Meridian Build Partners)",
      "amountPence": 1230000,
      "currency": "GBP",
      "timestamp": "2026-09-16T08:30:00Z"
    }
  ]
}
```

---

### 3.2 `GET /api/portal/debtors`

#### Purpose
Returns the filterable, sortable, and searchable debtor ledger list for the authenticated client.

#### Query Parameters
| Parameter | Type | Default | Values / Description |
|---|---|---|---|
| `stage` | string | `'all'` | `'all'`, `'1'`, `'2'`, `'3'`, `'4'`, `'stage_1'`, `'stage_2'`, `'stage_3'`, `'stage_4'` |
| `status` | string | `'all'` | `'all'`, `'overdue'`, `'promised'`, `'paid'`, `'disputed'`, `'escalated'` |
| `sort` | string | `'days_overdue'` | `'days_overdue'`, `'amount'`, `'amount_pence'`, `'due_date'`, `'debtor_name'`, `'invoice_number'`, `'status'` |
| `dir` | string | `'desc'` | `'asc'`, `'desc'` |
| `search` / `q` | string | `''` | Debounced text matching `debtor_name`, `invoice_number`, or `debtor_email` |
| `page` | integer | `1` | 1-based page index |
| `limit` | integer | `50` | Page size (1 to 100) |
| `client_id`| integer | `null` | Admin/demo override |

#### SQL Query Pattern (Parameterized CTE)
```sql
WITH debtor_ledger AS (
  SELECT
    i.id,
    i.client_id,
    i.debtor_name,
    i.debtor_email,
    i.invoice_number,
    i.amount_pence,
    i.currency,
    i.due_date,
    i.issued_date,
    i.status,
    i.paid_date,
    CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
    COALESCE(
      (SELECT MAX(cl.step) FROM chase_log cl WHERE cl.invoice_id = i.id),
      CASE
        WHEN (julianday('now') - julianday(i.due_date)) < 1 THEN 0
        WHEN (julianday('now') - julianday(i.due_date)) <= 7 THEN 1
        WHEN (julianday('now') - julianday(i.due_date)) <= 14 THEN 2
        WHEN (julianday('now') - julianday(i.due_date)) <= 21 THEN 3
        ELSE 4
      END
    ) AS stage,
    (SELECT sent_at FROM chase_log cl WHERE cl.invoice_id = i.id ORDER BY sent_at DESC LIMIT 1) AS last_contact_at
  FROM invoices i
  WHERE i.client_id = ?1
)
SELECT * FROM debtor_ledger
WHERE 1=1
  AND (?2 IS NULL OR stage = ?2)
  AND (?3 IS NULL OR status = ?3)
  AND (?4 IS NULL OR debtor_name LIKE ?4 OR invoice_number LIKE ?4 OR debtor_email LIKE ?4)
ORDER BY {validatedSortColumn} {validatedSortDir}
LIMIT ?5 OFFSET ?6;
```

#### JSON Response Schema (200 OK)
```json
{
  "ok": true,
  "clientId": 1,
  "debtors": [
    {
      "id": 1,
      "invoice_number": "INV-2026-089",
      "debtor_name": "Hartley & Co Ltd",
      "debtor_email": "accounts@hartleyandco.co.uk",
      "amount_pence": 485000,
      "currency": "GBP",
      "due_date": "2026-08-23",
      "days_overdue": 24,
      "stage": 4,
      "stage_label": "Stage 4 (Final)",
      "status": "overdue",
      "last_contact": "2026-09-14T08:30:00Z"
    }
  ],
  "total": 12,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

---

### 3.3 `GET /api/admin/drafts` (and `GET /api/chase/queue`)

#### Purpose
Retrieves all unapproved drafts (`status = 'draft'`) awaiting human review in the review queue, enriched with dynamic statutory interest and compensation calculations.

#### Calculation Logic
- Base rate: `env.BOE_BASE_RATE_PERCENT` (e.g. 3.75%).
- Statutory margin: 8%. Annual rate: `boeRate + 8%` (e.g. 11.75%).
- Daily interest formula: `Math.round(((amountPence * (boeRate + 8)) / 100 / 365) * daysOverdue)`.
- Fixed compensation tiers:
  - `< £1,000` (`< 100_000` pence): `4000` pence (£40)
  - `£1,000 – £9,999.99` (`100_000` to `999_999` pence): `7000` pence (£70)
  - `≥ £10,000` (`≥ 1_000_000` pence): `10000` pence (£100)
- Total claim: `amount_pence + statutory_interest_pence + fixed_compensation_pence`.

#### SQL Query
```sql
SELECT
  cl.id,
  cl.invoice_id,
  cl.step,
  cl.channel,
  cl.subject,
  cl.body,
  cl.status,
  cl.sent_at,
  i.invoice_number,
  i.debtor_name,
  i.debtor_email,
  i.amount_pence,
  i.currency,
  i.due_date,
  CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
  c.company_name
FROM chase_log cl
JOIN invoices i ON i.id = cl.invoice_id
JOIN clients c ON c.id = i.client_id
WHERE cl.status = 'draft'
  AND (?1 IS NULL OR c.id = ?1)
ORDER BY cl.sent_at ASC;
```

#### JSON Response Schema (200 OK)
```json
{
  "ok": true,
  "drafts": [
    {
      "id": 101,
      "invoice_id": 1,
      "invoice_number": "INV-2026-089",
      "debtor_name": "Hartley & Co Ltd",
      "debtor_email": "accounts@hartleyandco.co.uk",
      "company_name": "Apex Studio Ltd",
      "currency": "GBP",
      "due_date": "2026-08-23",
      "days_overdue": 24,
      "step": 4,
      "step_label": "Stage 4 (Final Notice)",
      "subject": "FINAL DEMAND — Overdue Invoice INV-2026-089 (Hartley & Co Ltd)",
      "body": "Dear Accounts Team,\n\nWe write regarding outstanding invoice INV-2026-089...",
      "locked_sender": "hello@invoicerescue.co.uk",
      "amount_pence": 485000,
      "principal_pence": 485000,
      "days_overdue": 24,
      "fixed_compensation_pence": 7000,
      "statutory_interest_pence": 3747,
      "total_claim_pence": 495747,
      "boe_base_rate_percent": 3.75
    }
  ],
  "count": 1
}
```

---

### 3.4 `POST /api/admin/drafts/:id/approve` (and `POST /api/chase/:id/approve`)

#### Purpose
Approves a draft, applies any operator/client in-place body edits, sends outbound debtor email via `env.SEND`, updates status to `'sent'`, records sent and reviewed timestamps, and sets `reviewed_by`.

#### Request Formats Supported
1. JSON: `{ "body": "...", "custom_message": "..." }`
2. Form data / URL-encoded: `body=...`
3. Empty body: sends stored draft body (`cl.body`).

#### Execution Steps & Guards
1. **Lookup**:
   ```sql
   SELECT cl.id, cl.body, cl.subject, i.debtor_email, i.invoice_number, i.client_id, c.company_name
   FROM chase_log cl
   JOIN invoices i ON i.id = cl.invoice_id
   JOIN clients c ON c.id = i.client_id
   WHERE cl.id = ?1 AND cl.status = 'draft';
   ```
2. **Guards**:
   - If not found or status != 'draft': Return 404 `{ "ok": false, "error": "Draft not found or already reviewed." }`.
   - If client authenticated via portal session: Must match `i.client_id === sessionClientId`. Otherwise return 403 Forbidden.
   - If `debtor_email` is null or invalid: Return 422 `{ "ok": false, "error": "Invoice has no debtor email on file." }`.
3. **Email Dispatch**:
   ```ts
   await env.SEND.send({
     to: row.debtor_email,
     from: { name: "Invoice Rescue", email: env.NOTIFY_FROM }, // Locked sender hello@invoicerescue.co.uk
     subject: row.subject ?? `Re: Invoice ${row.invoice_number}`,
     text: body,
   });
   ```
4. **Database State Transition**:
   ```sql
   UPDATE chase_log
   SET status = 'sent',
       body = ?2,
       outcome = 'sent',
       sent_at = datetime('now'),
       reviewed_at = datetime('now'),
       reviewed_by = ?3
   WHERE id = ?1 AND status = 'draft';
   ```
5. **Response**:
   - JSON client (`Accept: application/json`):
     ```json
     {
       "ok": true,
       "draft_id": 101,
       "status": "sent",
       "recipient": "accounts@hartleyandco.co.uk",
       "sent_at": "2026-09-16T08:30:00Z"
     }
     ```
   - Browser HTML form: `303 See Other` to `/admin` or `/dashboard/approval-queue.html`.

---

### 3.5 `POST /api/admin/drafts/:id/skip` (and `POST /api/chase/:id/skip`)

#### Purpose
Skips or defers a draft in the review queue. No email is sent.

#### Execution Steps & Guards
1. Check draft exists with `status = 'draft'`. If not found -> 404.
2. If client session auth, verify tenant ownership.
3. Update database:
   ```sql
   UPDATE chase_log
   SET status = 'skipped',
       reviewed_at = datetime('now'),
       reviewed_by = ?2
   WHERE id = ?1 AND status = 'draft';
   ```
4. Response:
   - JSON: `{ "ok": true, "draft_id": 101, "status": "skipped" }`
   - Form post: `303 See Other` to `/admin`.

---

### 3.6 `PUT /api/admin/drafts/:id` (and `PUT /api/chase/:id`)

#### Purpose
Allows operator or client to save in-place draft edits without dispatching the email immediately.

#### Request Body
```json
{
  "body": "Updated chase message text...",
  "subject": "Updated subject line"
}
```

#### Validation & Guards
- `id` must exist with `status = 'draft'` in `chase_log`. (If not -> 404).
- `body` (or `custom_message`) must be a non-empty string. (If missing/empty -> 400 Bad Request).
- Tenant scoping check if authenticated via portal session. (If mismatch -> 403 Forbidden).

#### Database Update
```sql
UPDATE chase_log
SET body = ?2,
    subject = COALESCE(?3, subject)
WHERE id = ?1 AND status = 'draft';
```

#### JSON Response (200 OK)
```json
{
  "ok": true,
  "draft_id": 101,
  "body": "Updated chase message text...",
  "subject": "Updated subject line"
}
```

---

## 4. Architectural & Edge Runtime Constraints

### 4.1 Zero External Runtime Dependencies
The implementation uses exclusively standard Web APIs built into the Cloudflare Worker runtime:
- `Request`, `Response`, `URL`, `Headers`
- `crypto.subtle` for HMAC-SHA256 token verification
- `env.DB` (D1 Database) with parameterized prepared statements
- `env.SEND` (Worker Email Sending binding) for debtor delivery

### 4.2 Split-Trust Routing & Locked Sender Compliance
- **Debtor Communications (`env.SEND`)**:
  - Sender: `hello@invoicerescue.co.uk` (`env.NOTIFY_FROM`)
  - Display Name: `Invoice Rescue`
  - Sign-off: Tibor Rames on behalf of `{client.company_name}`
- **Operator Notifications (`env.NOTIFY`)**:
  - Internal alerts (e.g. new leads, terminal Stage 4 escalations, failed payments) routed strictly to `env.NOTIFY_TO` (`tiborcc2@gmail.com`).

### 4.3 Multi-Tenant Boundary Protection
1. Query Scoping: All invoice and ledger queries strictly parameterize `client_id = ?1`.
2. Cross-Tenant Escalation Rejection: Any request with an authenticated portal session (`portal_session`) that attempts to view or modify an invoice or draft belonging to a different `client_id` is rejected immediately with HTTP 403 Forbidden.
3. No SQL concatenation: All search strings, limits, offsets, and IDs are bound as positional parameters (`?1`, `?2`, etc.).

---

## 5. Modular Implementation Proposal

To maintain clean code standards and preserve modularity in `backend/src/index.ts`, all portal and draft review endpoint logic should be encapsulated in `backend/src/lib/portal-api.ts`.

### Proposed File Layout
- **`backend/src/lib/portal-api.ts`**:
  - `handlePortalDashboardData(request: Request, env: Env): Promise<Response>`
  - `handlePortalDebtors(request: Request, env: Env): Promise<Response>`
  - `handleGetDrafts(request: Request, env: Env): Promise<Response>`
  - `handleApproveDraft(request: Request, env: Env, draftId: string): Promise<Response>`
  - `handleSkipDraft(request: Request, env: Env, draftId: string): Promise<Response>`
  - `handleUpdateDraft(request: Request, env: Env, draftId: string): Promise<Response>`
  - `resolvePortalClientId(request: Request, env: Env): Promise<number | null>`
- **`backend/src/index.ts`**:
  - Import handlers and dispatch routes in `fetch()`:
    - `GET /api/portal/dashboard-data`
    - `GET /api/portal/debtors`
    - `GET /api/admin/drafts` & `GET /api/chase/queue`
    - `POST /api/admin/drafts/:id/approve` & `POST /api/chase/:id/approve`
    - `POST /api/admin/drafts/:id/skip` & `POST /api/chase/:id/skip`
    - `PUT /api/admin/drafts/:id` & `PUT /api/chase/:id`

---

## 6. Comprehensive Test Plan (`tests/portal-endpoints.test.ts`)

The test suite will use the existing Node test runner (`node:test`, `node:assert/strict`) and `tests/e2e/harness.ts`.

### Test Suite Structure
```ts
describe("Milestone M3: Portal Dashboard, Debtor Ledger & Review Queue Endpoints", () => {
  // Setup & Fixtures
  describe("GET /api/portal/dashboard-data", () => {
    test("1. Returns zeroed metrics gracefully when database is empty");
    test("2. Unauthenticated request falls back to default active client");
    test("3. Authenticated client session cookie scopes metrics strictly to client");
    test("4. Accurately calculates totalOverduePence, activeChasingPence, recoveredMonthPence, overdueCount");
    test("5. Accurately computes aging gauge buckets (1-7d, 8-14d, 15-21d, 22d+) and percentages");
    test("6. Returns combined recent activity feed sorted chronologically");
  });

  describe("GET /api/portal/debtors", () => {
    test("7. Returns debtor ledger with calculated days_overdue, stage, and stage_label");
    test("8. Filters debtors by stage (1, 2, 3, 4, stage_1, stage_4)");
    test("9. Filters debtors by status (overdue, promised, paid, disputed)");
    test("10. Multi-column sorting (days_overdue, amount_pence, due_date, debtor_name) ASC and DESC");
    test("11. Debounced search matches debtor name, invoice number, and email");
    test("12. Strict multi-tenant isolation: Client A cannot view Client B debtors");
  });

  describe("GET /api/admin/drafts & GET /api/chase/queue", () => {
    test("13. Returns all unapproved drafts with status = 'draft'");
    test("14. Calculates dynamic statutory interest (BoE + 8%) with zero drift");
    test("15. Calculates statutory fixed compensation tiers (£40, £70, £100)");
    test("16. Computes total claim pence matching principal + interest + compensation");
    test("17. Returns locked sender hello@invoicerescue.co.uk");
  });

  describe("POST /api/admin/drafts/:id/approve & POST /api/chase/:id/approve", () => {
    test("18. Approves draft, dispatches email via env.SEND, updates status to 'sent'");
    test("19. Sets reviewed_at timestamp and reviewed_by operator name");
    test("20. Preserves edited draft body in JSON or form-data");
    test("21. Returns 404 when draft does not exist or was already reviewed");
    test("22. Returns 422 when invoice has no debtor email");
    test("23. Returns 403 when client attempts to approve another tenant draft");
  });

  describe("POST /api/admin/drafts/:id/skip & POST /api/chase/:id/skip", () => {
    test("24. Skips draft, sets status to 'skipped' and records reviewed_at");
    test("25. Returns 404 when draft does not exist");
  });

  describe("PUT /api/admin/drafts/:id & PUT /api/chase/:id", () => {
    test("26. Updates draft body text in-place in chase_log");
    test("27. Returns 400 when body text is empty or missing");
    test("28. Returns 404 when draft does not exist");
  });
});
```

---

## 7. Conclusion & Next Steps

This analysis provides the complete architectural and contract foundation for Milestone M3.
The implementer can:
1. Create `backend/src/lib/portal-api.ts` implementing the described endpoints and SQL queries.
2. Wire up the routes in `backend/src/index.ts`.
3. Add the test suite in `tests/portal-endpoints.test.ts`.
4. Verify edge bundling (`npm run build`) and test execution (`npm test`).
