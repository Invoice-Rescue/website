<!-- Generated: 2026-09-14 | Files scanned: 31 | Token estimate: ~800 -->
# Data Architecture Codemap

## Database Engine

Data persistence is managed via **Cloudflare D1 SQLite** (binding `DB`, database name `invoice-rescue-db`). Migrations are tracked deterministically using `wrangler d1 migrations`.

## Entity Relationship Diagram

```text
┌─────────────────┐
│      leads      │  (Independent lead pipeline from landing page)
└─────────────────┘

┌─────────────────┐        1:N         ┌─────────────────┐        1:N         ┌─────────────────┐
│     clients     │ ─────────────────< │    invoices     │ ─────────────────< │    chase_log    │
└─────────────────┘                    └─────────────────┘                    └─────────────────┘
```

## Schema & Tables

### 1. `leads`

Captures prospective audit requests submitted through [`frontend/index.html`](file:///D:/Dev/Workspaces/Active/invoice-rescue/frontend/index.html).

- `id` (INTEGER, PK, AUTOINCREMENT)
- `name` (TEXT, NOT NULL), `email` (TEXT, NOT NULL), `company` (TEXT)
- `overdue_band` (TEXT, CHECK: `'under_5k'`, `'5k_25k'`, `'25k_100k'`, `'over_100k'`, `'not_sure'`)
- `message` (TEXT), `source` (TEXT, DEFAULT `'landing_page'`)
- `status` (TEXT, NOT NULL, DEFAULT `'new'`, CHECK: `'new'`, `'contacted'`, `'call_booked'`, `'client'`, `'lost'`)
- `created_at` (TEXT, ISO8601)

### 2. `clients`

Active paying customers subscribing to credit control tiers.

- `id` (INTEGER, PK, AUTOINCREMENT)
- `company_name` (TEXT, NOT NULL), `contact_name` (TEXT), `contact_email` (TEXT, NOT NULL)
- `plan` (TEXT, NOT NULL, DEFAULT `'engine'`, CHECK: `'foundation'`, `'engine'`, `'operator'`)
- `status` (TEXT, NOT NULL, DEFAULT `'onboarding'`, CHECK: `'onboarding'`, `'active'`, `'paused'`, `'churned'`)
- `accounting_source` (TEXT, CHECK: `'xero'`, `'quickbooks'`, `'csv'`)
- `voice_notes` (TEXT) — client-specific communication style preferences
- `stripe_customer_id` (TEXT) — linked Stripe customer for billing portal
- `created_at` (TEXT, ISO8601)

### 3. `invoices`

Individual overdue debtor invoices being chased on behalf of clients.

- `id` (INTEGER, PK, AUTOINCREMENT)
- `client_id` (INTEGER, NOT NULL, FK ➔ `clients.id`)
- `debtor_name` (TEXT, NOT NULL), `debtor_email` (TEXT)
- `invoice_number` (TEXT, NOT NULL)
- `amount_pence` (INTEGER, NOT NULL) — integer pence representation to prevent float drift
- `currency` (TEXT, DEFAULT `'GBP'`), `issued_date` (TEXT), `due_date` (TEXT, NOT NULL)
- `status` (TEXT, NOT NULL, DEFAULT `'overdue'`, CHECK: `'overdue'`, `'promised'`, `'disputed'`, `'paid'`, `'escalated'`)
- `external_id` (TEXT), `paid_date` (TEXT), `last_synced_at` (TEXT), `created_at` (TEXT, ISO8601)
- **Constraint**: `UNIQUE(client_id, invoice_number)` prevents duplicate CSV re-imports.

### 4. `chase_log`

Audit trail of every AI-drafted, approved, and sent escalation message.

- `id` (INTEGER, PK, AUTOINCREMENT)
- `invoice_id` (INTEGER, NOT NULL, FK ➔ `invoices.id`)
- `step` (INTEGER, NOT NULL) — 1 (gentle), 2 (firm + statutory notice), 3 (formal final demand)
- `channel` (TEXT, DEFAULT `'email'`), `subject` (TEXT), `body` (TEXT)
- `status` (TEXT, NOT NULL, DEFAULT `'sent'`, CHECK: `'draft'`, `'sent'`, `'skipped'`)
- `outcome` (TEXT, CHECK: `'sent'`, `'replied'`, `'promised'`, `'paid'`, `'bounced'`)
- `sent_at` (TEXT), `reviewed_at` (TEXT), `reviewed_by` (TEXT) — human reviewer audit trail

## Migration History

| Migration | File | Description |
| --- | --- | --- |
| `0001` | [`0001_initial_schema.sql`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/db/migrations/0001_initial_schema.sql) | Baseline D1 tables (`leads`, `clients`, `invoices`, `chase_log`) & indexes |
| `0002` | [`0002_credit_control.sql`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/db/migrations/0002_credit_control.sql) | Adds `voice_notes`, `external_id`, draft `body`, and review timestamps |
| `0003` | [`0003_add_check_constraints.sql`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/db/migrations/0003_add_check_constraints.sql) | Adds SQLite CHECK constraints for status/plans and UNIQUE invoice guard |
| `0004` | [`0004_client_portal_and_billing.sql`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/db/migrations/0004_client_portal_and_billing.sql) | Adds `clients.stripe_customer_id` and `chase_log.reviewed_by` |
