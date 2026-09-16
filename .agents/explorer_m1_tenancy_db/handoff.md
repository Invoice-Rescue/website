# Handoff Report: M1 Multi-Tenant Data Architecture & Repository Design

**Author:** M1 Tenancy DB Explorer  
**Date:** 2026-09-16  
**Status:** Task Complete (Hard Handoff)  
**Target File Reference:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_tenancy_db\report.md`

---

## 1. Observation

1. **Database Schema & Constraints**:
   - `backend/db/migrations/0001_initial_schema.sql:37`: `invoices.client_id INTEGER NOT NULL REFERENCES clients(id)`.
   - `backend/db/migrations/0003_add_check_constraints.sql:73`: `UNIQUE (client_id, invoice_number)` on table `invoices`.
   - `backend/db/migrations/0006_accounting_connections_and_external_sync.sql:1-14`:
     `CREATE TABLE IF NOT EXISTS accounting_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')), tenant_id TEXT, access_token_encrypted TEXT NOT NULL, refresh_token_encrypted TEXT NOT NULL, expires_at TEXT NOT NULL, last_synced_at TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')), created_at TEXT NOT NULL DEFAULT (datetime('now')));`
     `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_connections_client_provider ON accounting_connections (client_id, provider);`
   - `backend/db/migrations/0006_accounting_connections_and_external_sync.sql:16-22`:
     `CREATE TABLE IF NOT EXISTS accounting_webhook_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')), event_type TEXT NOT NULL, payload TEXT NOT NULL, processed_at TEXT NOT NULL DEFAULT (datetime('now')));`

2. **Current Query Patterns in Worker (`backend/src/index.ts`)**:
   - Lines 434-450 (`handleInvoiceImport`): Inserts directly with `INSERT INTO invoices (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, external_id, last_synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'overdue', NULL, datetime('now'))`. Any duplicate `(client_id, invoice_number)` will fail with unhandled `SQLITE_CONSTRAINT_UNIQUE` exception.
   - Lines 473-479 (`handleChaseApprove`): `SELECT cl.id, cl.body, cl.subject, i.debtor_email, i.invoice_number FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id WHERE cl.id = ?1 AND cl.status = 'draft'` filters only on `cl.id = ?1` without `i.client_id = ?2`.
   - Lines 521-525 (`handleChaseSkip`): `UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE id = ?1 AND status = 'draft'` filters only on `id = ?1` without validating tenant ownership.
   - Lines 618-632 (`handlePortalDashboard`): Properly filters `WHERE client_id = ?1` for invoices and `WHERE i.client_id = ?1` for chases.
   - Lines 22-26 (`backend/src/lib/integrations/sync-service.ts`): Dummy stub:
     `export class SyncService { async syncInvoices(clientId: number) { return { success: true }; } }`

3. **Runtime & Test Verification**:
   - Executed `node -e "console.log(process.version)"`: returned `v25.9.0`.
   - Executed `node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); console.log('node:sqlite works!');"`: returned `node:sqlite works!`.
   - Executed `npm run verify`: `npm run lint` (0 issues), `tsc --noEmit` (0 errors), `npm test` (31 passed, 0 failed, 6 suites), `npm run build` (wrangler deploy --dry-run: 42.84 KiB clean).

---

## 2. Logic Chain

1. **Premise 1 (From Observation 1)**: Database migrations enforce relational foreign keys (`client_id REFERENCES clients(id)`) and composite uniqueness `UNIQUE (client_id, invoice_number)`. This means the underlying SQLite database is already structured to isolate tenants and support duplicate invoice numbers across different clients.
2. **Premise 2 (From Observation 2)**: The application codebase currently executes raw SQL queries directly in `backend/src/index.ts`. Because there is no centralized repository layer, there is no enforcement mechanism preventing queries from omitting `client_id`.
3. **Premise 3 (From Observation 2 - `handleInvoiceImport`)**: Because `handleInvoiceImport` performs a naive `INSERT INTO invoices`, re-importing a CSV or syncing duplicate invoice numbers for the same tenant triggers `SQLITE_CONSTRAINT_UNIQUE`, causing HTTP 500 crashes and partial data imports.
4. **Premise 4 (From Observation 2 - `handleChaseApprove`/`skip`)**: Mutating `chase_log` without joining and filtering on `invoices.client_id = ?` creates an unauthorized cross-tenant mutation vulnerability when draft review is exposed to clients.
5. **Premise 5 (From Observation 1 & 2 - Webhooks)**: Incoming webhooks only carry provider IDs (`tenant_id` / `realmId`), not internal `client_id`. An explicit resolver `resolveClientByAccountingTenant(provider, tenantId)` is required before any tenant-scoped operations can safely run.
6. **Premise 6 (From Observation 3)**: Node v25.9.0 natively provides `node:sqlite`. An in-memory D1 test adapter can be constructed using `new DatabaseSync(':memory:')` executing migrations `0001` through `0006`. This allows automated testing of multi-tenant isolation, unique constraints, and SQL queries offline with zero external runtime dependencies.
7. **Deductive Conclusion**: Designing `backend/src/lib/tenant-repo.ts` (and exposing helpers via `backend/src/lib/db.ts`) with a dual functional and class-based API, implementing `INSERT ... ON CONFLICT(client_id, invoice_number) DO UPDATE`, and enforcing strict typed boundary validation eliminates cross-tenant leaks, prevents duplicate import crashes, protects settled invoices, and enables 100% offline test verification.

---

## 3. Caveats

1. **`accounting_webhook_events` Global Nature**:
   - `accounting_webhook_events` does not include a `client_id` column in migration `0006`. Deduplication operates globally across the system on the provider's unique event ID (`id TEXT PRIMARY KEY`). This is secure for idempotency, but per-tenant audit trails of webhook history will need to parse the stored JSON payload or join through accounting connections.
2. **Missing Index on `(provider, tenant_id)` in Migration 0006**:
   - Migration 0006 indexed `(client_id, provider)`. Looking up a tenant by `(provider, tenant_id)` will scan the `accounting_connections` table. For the current scale (tens to hundreds of clients), this is trivial in SQLite, but a future migration (`0007`) should add `idx_accounting_connections_provider_tenant`.
3. **Scope Constraint**:
   - Per explorer rules, no implementation code was written to source files. The design, exact function signatures, error types, and test harness are fully documented in `report.md` for the implementation phase.

---

## 4. Conclusion

A concrete, production-ready tenant-isolated data repository architecture has been designed in `report.md`. It provides:
1. Exact function signatures and implementations for the PROJECT.md §1 contract (`getTenantInvoices`, `getTenantInvoiceByNumber`, `getTenantInvoiceById`, `upsertTenantInvoice`, `recordAccountingWebhook`).
2. An object-oriented `TenantRepository` class permanently binding `this.clientId` to prevent accidental developer omission of tenant filters.
3. An atomic SQLite `INSERT ... ON CONFLICT(client_id, invoice_number) DO UPDATE` query that resolves CSV duplicate crashes while preserving settled/paid invoice states.
4. Fail-closed boundary validation guards and a typed error hierarchy (`InvalidTenantError`, `TenantBoundaryViolationError`, `InvalidInvoiceDataError`).
5. A zero-dependency `node:sqlite` in-memory D1 test harness pattern and 9-point test specification guaranteeing verification across all isolation boundaries.

---

## 5. Verification Method

To independently verify the facts and recommendations in this report:

1. **Verify Database Migrations & Constraints**:
   Inspect migration files directly:
   `view_file backend/db/migrations/0003_add_check_constraints.sql` (Line 73 for `UNIQUE (client_id, invoice_number)`).
   `view_file backend/db/migrations/0006_accounting_connections_and_external_sync.sql` (Tables and indexes).

2. **Verify Node.js Built-in SQLite Availability**:
   Run in PowerShell:
   `node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); console.log('node:sqlite works!');"`
   Expected output: `node:sqlite works!`.

3. **Verify Baseline Project Health**:
   Run in project root:
   `npm run verify`
   Expected result: All linters pass, `tsc --noEmit` exits 0, 31 tests pass, dry-run build succeeds.

4. **Review Architecture Report**:
   Inspect the full design document:
   `view_file .agents/explorer_m1_tenancy_db/report.md`.
