# Cloudflare D1 Database Migrations & Integrity Analysis Report
**Milestone**: M4 (Edge Infrastructure & Deliverability Controls - R4)  
**Date**: 2026-09-16  
**Investigator**: D1 Database Migrations & Integrity Explorer  
**Repository**: Invoice-Rescue / website  

---

## Executive Summary

A comprehensive forensic audit was conducted on all Cloudflare D1 SQL schema migrations, runtime execution integrity, SQLite constraint enforcement, high-frequency query indices, TypeScript entity type synchronization, and test harness execution.

### Core Audit Results
- **Migration Sequence Integrity**: 6 sequential migration files (`0001` through `0006`) exist in `backend/db/migrations/` with zero gaps, drift, or dangling files.
- **Wrangler Execution**: `npx wrangler d1 migrations apply invoice-rescue-db --local` verifies clean zero-error application. All 6 migrations are recorded in `d1_migrations`.
- **Constraint Enforcement**: `PRAGMA foreign_keys = 1` is active by default in both Cloudflare D1 local runtime and Node.js `DatabaseSync` test harness. Foreign keys (`REFERENCES clients(id)`, `REFERENCES invoices(id)`), check constraints (`amount_pence > 0`, enum checks), and unique constraints (`UNIQUE (client_id, invoice_number)`, `idx_accounting_connections_client_provider`) are strictly enforced at the SQLite storage layer.
- **TypeScript Type Alignment**: Entity interfaces across `backend/src/lib/tenant-repo.ts`, `backend/src/lib/portal-api.ts`, `backend/src/lib/integrations/accounting-types.ts`, and `backend/src/index.ts` match the D1 schema definitions with 100% field, nullability, and type precision.
- **Test Harness Consistency**: The test suite (464 passing tests) in `tests/e2e/harness.ts` dynamically loads all migrations from `backend/db/migrations/` in sequential order into an in-memory SQLite database, guaranteeing identical schema state between test suites and production.
- **Identified Optimization Opportunities**: 4 high-frequency query paths currently perform table scans or temporary B-tree sorts due to missing indices (`chase_log(status)`, `accounting_connections(provider, tenant_id)`, `clients(status)`, and `invoices(client_id, due_date DESC)`).

---

## 1. Migration Inventory & Schema Evolution

All migrations are tracked under `backend/db/migrations/` and configured via `wrangler.jsonc` (`migrations_dir: "./backend/db/migrations"`).

| Migration File | Purpose | Key Alterations & Additions |
|---|---|---|
| `0001_initial_schema.sql` | Baseline schema | Creates initial `leads`, `clients`, `invoices`, `chase_log` tables and 4 baseline indices. |
| `0002_credit_control.sql` | Credit control fields | Adds `external_id`, `last_synced_at` to `invoices`; `body`, `status`, `reviewed_at` to `chase_log`; `voice_notes` to `clients`. |
| `0003_add_check_constraints.sql` | Database-level integrity | Adds CHECK constraints for enums; adds `UNIQUE (client_id, invoice_number)` and `amount_pence > 0` CHECK on `invoices`; rebuilds tables with `PRAGMA defer_foreign_keys = TRUE`. |
| `0004_client_portal_and_billing.sql` | Portal & Stripe billing | Adds `stripe_customer_id` to `clients`; adds `reviewed_by` to `chase_log`. |
| `0005_webhook_events.sql` | Stripe webhook idempotency | Creates `webhook_events` table (`id` PRIMARY KEY) and composite index `(customer_id, created_at_timestamp)`. |
| `0006_accounting_connections_and_external_sync.sql` | External accounting sync | Creates `accounting_connections` with `UNIQUE (client_id, provider)` and `accounting_webhook_events` (`id` PRIMARY KEY). |

---

## 2. Table Schemas, Constraints & Foreign Keys

### Table 1: `clients`
```sql
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'engine' CHECK (plan IN ('foundation', 'engine', 'operator')),
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'paused', 'churned')),
  accounting_source TEXT CHECK (accounting_source IS NULL OR accounting_source IN ('xero', 'quickbooks', 'csv')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voice_notes TEXT,
  stripe_customer_id TEXT
);
```
- **Primary Key**: `id`
- **Constraints**:
  - `plan` CHECK: `'foundation'`, `'engine'`, `'operator'`
  - `status` CHECK: `'onboarding'`, `'active'`, `'paused'`, `'churned'`
  - `accounting_source` CHECK: NULL, `'xero'`, `'quickbooks'`, `'csv'`
- **Foreign Keys**: None (Root tenant entity)

### Table 2: `invoices`
```sql
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  invoice_number TEXT NOT NULL,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  issued_date TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'overdue' CHECK (status IN ('overdue', 'promised', 'disputed', 'paid', 'escalated')),
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  external_id TEXT,
  last_synced_at TEXT,
  UNIQUE (client_id, invoice_number)
);
```
- **Primary Key**: `id`
- **Foreign Key**: `client_id REFERENCES clients(id)`
- **Unique Constraint**: `UNIQUE (client_id, invoice_number)` ensures multi-tenant isolation so that identical invoice numbers across different clients do not collide, while prohibiting duplicate imports for the same tenant.
- **Check Constraints**:
  - `amount_pence > 0` (financial integrity, prevents negative/zero invoices)
  - `status IN ('overdue', 'promised', 'disputed', 'paid', 'escalated')`

### Table 3: `chase_log`
```sql
CREATE TABLE chase_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  step INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'replied', 'promised', 'paid', 'bounced')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'skipped')),
  reviewed_at TEXT,
  reviewed_by TEXT
);
```
- **Primary Key**: `id`
- **Foreign Key**: `invoice_id REFERENCES invoices(id)`
- **Check Constraints**:
  - `outcome IS NULL OR outcome IN ('sent', 'replied', 'promised', 'paid', 'bounced')`
  - `status IN ('draft', 'sent', 'skipped')`

### Table 4: `accounting_connections`
```sql
CREATE TABLE accounting_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')),
    tenant_id TEXT,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_synced_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_accounting_connections_client_provider ON accounting_connections (client_id, provider);
```
- **Primary Key**: `id`
- **Foreign Key**: `client_id REFERENCES clients(id)`
- **Unique Index**: `(client_id, provider)` guarantees only one active connection per accounting provider per client.
- **Check Constraints**:
  - `provider IN ('xero', 'quickbooks')`
  - `status IN ('active', 'expired', 'revoked')`

### Table 5: `accounting_webhook_events`
```sql
CREATE TABLE accounting_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')),
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
- **Primary Key**: `id TEXT`
- **Check Constraint**: `provider IN ('xero', 'quickbooks')`

### Table 6: `webhook_events` (Stripe)
```sql
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  customer_id TEXT,
  created_at_timestamp INTEGER NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_events_customer_created ON webhook_events (customer_id, created_at_timestamp);
```
- **Primary Key**: `id TEXT` (e.g. `evt_...`)

### Table 7: `leads`
```sql
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  overdue_band TEXT CHECK (overdue_band IS NULL OR overdue_band IN ('under_5k', '5k_25k', '25k_100k', 'over_100k', 'not_sure')),
  message TEXT,
  source TEXT DEFAULT 'landing_page',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'call_booked', 'client', 'lost')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 3. Constraint Enforcement Empirical Verification

Constraint enforcement was verified in both the live local Cloudflare D1 instance and the Node.js test harness:

1. **Foreign Key Enforcement**:
   - `PRAGMA foreign_keys;` query on local D1 returns `{"foreign_keys": 1}`.
   - Attempting to insert an invoice with an invalid `client_id = 9999` fails immediately with:
     ```
     FOREIGN KEY constraint failed
     ```
2. **CHECK Constraint Enforcement**:
   - Inserting an invoice with `amount_pence = -100` fails immediately with:
     ```
     CHECK constraint failed: amount_pence > 0
     ```
   - Inserting invalid enums fails immediately against the CHECK clause.
3. **UNIQUE Constraint Enforcement**:
   - Inserting two invoices with the same `(client_id, invoice_number)` fails with:
     ```
     UNIQUE constraint failed: invoices.client_id, invoices.invoice_number
     ```
   - Inserting two identical `invoice_number` values under different `client_id` succeeds cleanly.

---

## 4. Query Performance & Index Coverage Audit

Using `EXPLAIN QUERY PLAN`, every high-frequency query path was tested against the schema indices:

### 1. Invoices Scoped to Tenant
- **Query**: `SELECT ... FROM invoices WHERE client_id = ?1 ORDER BY due_date DESC`
- **Plan**: `SEARCH invoices USING INDEX idx_invoices_client (client_id=?)` + `USE TEMP B-TREE FOR ORDER BY`
- **Assessment**: Index `idx_invoices_client` resolves the filter. However, SQLite requires a temporary B-Tree sort for `ORDER BY due_date DESC`.
- **Recommendation**: Upgrading to a composite index `(client_id, due_date DESC)` would eliminate the temp B-tree.

### 2. Overdue Invoice Detection (Daily Cron)
- **Query**: `SELECT ... FROM invoices WHERE status = 'overdue' AND due_date < date('now')`
- **Plan**: `SEARCH invoices USING INDEX idx_invoices_status (status=? AND due_date<?)`
- **Assessment**: Optimal. Fully covered by composite index `idx_invoices_status`.

### 3. Review Queue Drafts
- **Query**: `SELECT ... FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id WHERE cl.status = 'draft'`
- **Plan**:
  - `SCAN cl`
  - `SEARCH i USING INTEGER PRIMARY KEY (rowid=?)`
- **Assessment**: Table scan on `chase_log` because `chase_log` lacks an index on `status`.
- **Recommendation**: Add index `CREATE INDEX idx_chase_status ON chase_log(status, sent_at);`.

### 4. Webhook Accounting Tenant Resolution
- **Query**: `SELECT client_id FROM accounting_connections WHERE provider = ?1 AND tenant_id = ?2 AND status = 'active'`
- **Plan**: `SCAN accounting_connections`
- **Assessment**: Table scan on `accounting_connections` because the unique index is on `(client_id, provider)`.
- **Recommendation**: Add index `CREATE INDEX idx_accounting_connections_lookup ON accounting_connections (provider, tenant_id);`.

### 5. Client Status Filtering (Friday Report)
- **Query**: `SELECT ... FROM clients WHERE status = 'active'`
- **Plan**: `SCAN clients`
- **Assessment**: Table scan on `clients`. Acceptable at small scale (<1,000 clients), but an index `idx_clients_status` will be needed at volume.

---

## 5. TypeScript Entity Mappings & Query Expectations

A strict comparison between D1 schema definitions and TypeScript interfaces confirmed 100% alignment:

| Table | TypeScript Interface | File Path | Field Mapping Status |
|---|---|---|---|
| `clients` | `ClientInput`, `ClientRow` | `backend/src/index.ts:136, 828` | Exact match |
| `clients` | `PortalClientRow` | `backend/src/lib/portal.ts:3` | Exact match |
| `invoices` | `TenantInvoice`, `UpsertInvoiceInput` | `backend/src/lib/tenant-repo.ts:10, 29` | Exact match (camelCase aliases in SQL match interface properties) |
| `invoices` | `PortalInvoiceRow` | `backend/src/lib/portal.ts:10` | Exact match |
| `chase_log` | `TenantChaseDraft` | `backend/src/lib/tenant-repo.ts:49` | Exact match |
| `chase_log` | `DraftRow` | `backend/src/lib/admin.ts:1` | Exact match |
| `chase_log` | `PortalChaseRow` | `backend/src/lib/portal.ts:19` | Exact match |
| `accounting_connections` | `TenantAccountingConnection` | `backend/src/lib/tenant-repo.ts:66` | Exact match |
| `accounting_connections` | `AccountingConnection` | `backend/src/lib/integrations/accounting-types.ts:1` | Exact match |
| `accounting_webhook_events` | `WebhookEvent` | `backend/src/lib/integrations/accounting-types.ts:14` | Exact match |
| `webhook_events` | (Raw queries in index.ts) | `backend/src/index.ts:757-776` | Exact match |

---

## 6. Test Harness Synchronization

In `tests/e2e/harness.ts`:
- The harness imports `DatabaseSync` from Node.js `node:sqlite`.
- It dynamically reads and applies all files ending in `.sql` from `backend/db/migrations/` sorted alphabetically.
- All test suites (`464 passing tests` across 96 test suites) instantiate and exercise the database against this exact migration pipeline.
- Both `PRAGMA foreign_keys = 1` and all SQL check constraints execute in tests with zero divergences from Cloudflare D1.

---

## 7. Migration Execution Integrity Verification

Commands executed and verified:
1. `npx wrangler d1 migrations apply invoice-rescue-db --local`
   - Exit code: 0
   - Output: `✅ No migrations to apply!` (All 6 migrations successfully applied)
2. `npx wrangler d1 execute invoice-rescue-db --local --command "SELECT * FROM d1_migrations;"`
   - Returns all 6 records (`0001` through `0006`).
3. `npm run typecheck` (`tsc --noEmit`)
   - Exit code: 0 (Zero type errors)
4. `npm run build` (`wrangler deploy --dry-run`)
   - Exit code: 0 (Bundles cleanly with all bindings)
5. `npm test`
   - Exit code: 0 (464 tests passing, 0 failing)

---

## 8. Concrete Recommendations for Future Migration (e.g. `0007_query_indices.sql`)

While the current database exhibits zero integrity bugs, adding the following indices will optimize queries under load:

```sql
-- Proposed 0007_query_indices.sql
CREATE INDEX IF NOT EXISTS idx_invoices_client_due ON invoices (client_id, due_date DESC);
CREATE INDEX IF NOT EXISTS idx_chase_status_sent ON chase_log (status, sent_at);
CREATE INDEX IF NOT EXISTS idx_accounting_connections_lookup ON accounting_connections (provider, tenant_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients (status);
```
