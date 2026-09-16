# Challenger 2 Report: Milestone M4 (D1 Query Indexing & Migration Drift Stress - R4)

**Role**: Milestone M4 Empirical Challenger 2 (`challenger_m4_2`)  
**Mission**: Stress-test D1 migrations, query index usage via `EXPLAIN QUERY PLAN`, and schema constraint enforcement.  
**Verdict**: **APPROVE**  
**Risk Assessment**: **LOW**

---

## 1. Executive Summary

Milestone M4 implementation by `worker_m4` introduced migration `0007_query_indices.sql`, which provides 4 performance indices covering high-frequency access paths in the credit-control state machine and API routes.

As Challenger 2, an exhaustive empirical stress-test was conducted on:
1. **Migration Integrity & Idempotency**: Verified clean application, absence of drift, idempotency upon repeated execution, and clean state in `d1_migrations`.
2. **Query Performance Plan Verification**: Verified via SQLite `EXPLAIN QUERY PLAN` that all four target queries utilize their designated indexes, and specifically verified that `invoices(client_id, due_date DESC)` completely eliminates temporary B-tree sorting.
3. **Schema Constraint Stress**: Verified that SQLite foreign key enforcement (`PRAGMA foreign_keys = ON;`) strictly prevents orphan invoices and orphan chase logs, and that `UNIQUE (client_id, invoice_number)` prevents invoice collisions within a tenant while allowing identical numbering across isolated tenants.
4. **Automated Stress Harness**: Created and executed `tests/challenger-m4-d1-indexing-stress.test.ts` (21/21 passing tests). The entire test suite now stands at 519 passing tests with 0 failures.

---

## 2. Empirical Verification Evidence

### 2.1 Migration Integrity & Idempotency

#### A. Migration File Definition (`backend/db/migrations/0007_query_indices.sql`)
```sql
-- Migration: 0007_query_indices.sql
-- High-frequency performance indices for Edge Infrastructure & Deliverability Controls (Milestone M4 / R4)

CREATE INDEX IF NOT EXISTS idx_chase_log_status ON chase_log(status);
CREATE INDEX IF NOT EXISTS idx_accounting_connections_lookup ON accounting_connections(provider, tenant_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_invoices_client_due ON invoices(client_id, due_date DESC);
```

#### B. Wrangler D1 Migration Status
Re-executing local migration apply confirmed clean idempotency:
```powershell
PS D:\Dev\Workspaces\Active\invoice-rescue> npx wrangler d1 migrations apply invoice-rescue-db --local
 ⛅️ wrangler 4.131.0 (update available 4.132.0)
───────────────────────────────────────────────
Resource location: local 

Use --remote if you want to access the remote instance.

✅ No migrations to apply!
```

#### C. Applied Migrations Table Audit (`d1_migrations`)
```json
[
  { "id": 1, "name": "0001_initial_schema.sql", "applied_at": "2026-07-28 20:44:51" },
  { "id": 2, "name": "0002_credit_control.sql", "applied_at": "2026-07-28 20:44:52" },
  { "id": 3, "name": "0003_add_check_constraints.sql", "applied_at": "2026-07-28 20:44:53" },
  { "id": 4, "name": "0004_client_portal_and_billing.sql", "applied_at": "2026-08-13 01:21:42" },
  { "id": 5, "name": "0005_webhook_events.sql", "applied_at": "2026-09-14 06:59:58" },
  { "id": 6, "name": "0006_accounting_connections_and_external_sync.sql", "applied_at": "2026-09-16 04:53:05" },
  { "id": 7, "name": "0007_query_indices.sql", "applied_at": "2026-09-16 13:14:50" }
]
```

#### D. Schema Integrity Check
Execution of `PRAGMA integrity_check;` on `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/e1679c68e96d0066649d19cf7dd33a43377fa6243b5ffe851c9d9a9490120e0f.sqlite`:
```json
[ { "integrity_check": "ok" } ]
```

#### E. Re-Execution Stress Test
Executing the DDL statements in `0007_query_indices.sql` repeatedly (5 consecutive runs) against an active database yielded zero errors and preserved an index count of exactly 4 without duplication or degradation.

---

### 2.2 Query Performance Plan Verification (`EXPLAIN QUERY PLAN`)

Both the live Wrangler local D1 SQLite database and fresh in-memory test databases were queried with `EXPLAIN QUERY PLAN`. In addition, adversarial contrast tests were conducted by dropping the index to demonstrate performance degradation to table scans or temporary B-trees.

#### Query A: Chase Log Status Scan
**SQL**: `SELECT id FROM chase_log WHERE status = 'draft'`
- **With `idx_chase_log_status`**:
  ```json
  [
    {
      "id": 2,
      "parent": 0,
      "notused": 53,
      "detail": "SEARCH chase_log USING COVERING INDEX idx_chase_log_status (status=?)"
    }
  ]
  ```
- **Without index (Contrast)**:
  `SCAN chase_log` (full table scan).
- **Assessment**: PASSED. Evaluates as a covering index search because primary key `id` is embedded in the B-tree leaf node. Zero row fetch required.

#### Query B: Accounting Connection Lookup
**SQL**: `SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?`
- **With `idx_accounting_connections_lookup`**:
  ```json
  [
    {
      "id": 3,
      "parent": 0,
      "notused": 61,
      "detail": "SEARCH accounting_connections USING INDEX idx_accounting_connections_lookup (provider=? AND tenant_id=?)"
    }
  ]
  ```
- **Without index (Contrast)**:
  `SCAN accounting_connections` (full table scan).
- **Assessment**: PASSED. Composite index `(provider, tenant_id)` eliminates table scanning during webhook resolution.

#### Query C: Active Clients Lookup
**SQL**: `SELECT id FROM clients WHERE status = 'active'`
- **With `idx_clients_status`**:
  ```json
  [
    {
      "id": 2,
      "parent": 0,
      "notused": 53,
      "detail": "SEARCH clients USING COVERING INDEX idx_clients_status (status=?)"
    }
  ]
  ```
- **Without index (Contrast)**:
  `SCAN clients` (full table scan).
- **Assessment**: PASSED. Evaluates as a covering index lookup on `clients(status)` with rowid.

#### Query D: Tenant Invoices Ordered by Due Date
**SQL**: `SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC`
- **With `idx_invoices_client_due`**:
  ```json
  [
    {
      "id": 3,
      "parent": 0,
      "notused": 53,
      "detail": "SEARCH invoices USING COVERING INDEX idx_invoices_client_due (client_id=?)"
    }
  ]
  ```
- **Without composite index (Contrast)**:
  ```
  SEARCH invoices USING INDEX idx_invoices_client (client_id=?)
  USE TEMP B-TREE FOR ORDER BY
  ```
- **Assessment**: PASSED. The composite descending index `(client_id, due_date DESC)` directly traverses the B-tree in required sort order, completely eliminating the SQLite temporary B-tree sort buffer (`USE TEMP B-TREE FOR ORDER BY`).

---

### 2.3 Schema Constraint Stress

#### A. Foreign Key Enforcement (`PRAGMA foreign_keys = ON;`)
Tested adversarial operations to verify referential integrity:
1. **Orphan Invoice Insertion**:
   - `INSERT INTO invoices (client_id, ...)` with non-existent `client_id = 999999`.
   - **Result**: Throws `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`. Rejected.
2. **Client Deletion with Dependent Invoices**:
   - `DELETE FROM clients WHERE id = 1` where Client 1 owns active invoices.
   - **Result**: Throws `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`. Client deletion blocked.
3. **Orphan Chase Log Insertion**:
   - `INSERT INTO chase_log (invoice_id, ...)` with non-existent `invoice_id = 888888`.
   - **Result**: Throws `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`. Rejected.
4. **Invoice Deletion with Dependent Chase Logs**:
   - `DELETE FROM invoices WHERE id = 20` where Invoice 20 owns chase log entries.
   - **Result**: Throws `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`. Invoice deletion blocked.
5. **Orphan Accounting Connection Insertion**:
   - `INSERT INTO accounting_connections (client_id, ...)` with non-existent `client_id = 77777`.
   - **Result**: Throws `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed`. Rejected.

#### B. Tenant Unique Constraint (`UNIQUE (client_id, invoice_number)`)
1. **Intra-Tenant Duplicate Invoice Number**:
   - Client 1 inserts `INV-DUP-100`. Client 1 attempts second insertion of `INV-DUP-100`.
   - **Result**: Throws `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: invoices.client_id, invoices.invoice_number`. Duplicate blocked.
2. **Inter-Tenant Invoice Number Collision (Tenant Isolation)**:
   - Client 1 has `INV-COMMON-001`. Client 2 inserts `INV-COMMON-001`.
   - **Result**: Succeeded cleanly. Both rows exist independently. Proves multi-tenant isolation.
3. **Colliding Update**:
   - Existing invoices `INV-A` and `INV-B` under Client 1. Updating `INV-B` to `INV-A`.
   - **Result**: Throws `SQLITE_CONSTRAINT_UNIQUE`. Blocked.
4. **Provider Connection Constraint (`UNIQUE (client_id, provider)`)**:
   - Client 1 inserts Xero connection. Client 1 attempts second Xero connection.
   - **Result**: Throws `SQLITE_CONSTRAINT_UNIQUE`. Blocked.
   - Client 1 inserting QuickBooks connection alongside Xero: Succeeded cleanly.

#### C. Domain CHECK Constraints
1. **Invoice Amount**: `amount_pence = 0` or `amount_pence = -5000` -> Throws `SQLITE_CONSTRAINT_CHECK`. Zero/negative debts prohibited.
2. **Invoice Status**: Inserting status `'nonexistent_status'` -> Throws `SQLITE_CONSTRAINT_CHECK`.
3. **Chase Log Status**: Values restricted strictly to `('draft', 'sent', 'skipped')`. Inserting invalid status throws `SQLITE_CONSTRAINT_CHECK`.

---

### 2.4 Stress Test Harness Results

Automated test suite `tests/challenger-m4-d1-indexing-stress.test.ts` executed with 100% pass rate:

```powershell
PS D:\Dev\Workspaces\Active\invoice-rescue> npx tsx --test tests/challenger-m4-d1-indexing-stress.test.ts
▶ Milestone M4 Stress Suite — Challenger 2 (D1 Query Indexing, Migrations & Constraint Stress)
  ▶ 1. Migration 0007 Integrity & Idempotency
    ✔ 1.1 Migration file 0007_query_indices.sql exists and defines all 4 required performance indexes (2.4815ms)
    ✔ 1.2 Applying migrations 0001 through 0007 sequentially builds a valid schema with all 4 indexes (7.0369ms)
    ✔ 1.3 Migration 0007 execution is completely idempotent (multiple executions produce zero errors) (10.3345ms)
    ✔ 1.4 Local Wrangler D1 SQLite database file contains all 4 indexes and passes PRAGMA integrity_check (3.8022ms)
  ✔ 1. Migration 0007 Integrity & Idempotency (25.0539ms)
  ▶ 2. Query Performance Plan Verification (EXPLAIN QUERY PLAN)
    ✔ 2.1 Query A: 'SELECT id FROM chase_log WHERE status = 'draft'' uses idx_chase_log_status instead of table scan (8.9738ms)
    ✔ 2.2 Query B: 'SELECT client_id FROM accounting_connections WHERE provider = ? AND tenant_id = ?' uses idx_accounting_connections_lookup (8.4657ms)
    ✔ 2.3 Query C: 'SELECT id FROM clients WHERE status = 'active'' uses idx_clients_status (7.8327ms)
    ✔ 2.4 Query D: 'SELECT id FROM invoices WHERE client_id = ? ORDER BY due_date DESC' uses idx_invoices_client_due WITHOUT temporary B-tree sort (9.3644ms)
    ✔ 2.5 Verify query plans directly against the live local D1 SQLite database (2.7963ms)
  ✔ 2. Query Performance Plan Verification (EXPLAIN QUERY PLAN) (38.3607ms)
  ▶ 3. Foreign Key Constraint Stress (PRAGMA foreign_keys = ON)
    ✔ 3.1 Prevents orphan invoices: inserting invoice with non-existent client_id throws foreign key constraint failure (7.467ms)
    ✔ 3.2 Prevents orphan chase_log entries: inserting chase_log with non-existent invoice_id throws foreign key failure (5.9426ms)
    ✔ 3.3 Prevents client deletion when active invoices reference it (7.2155ms)
    ✔ 3.4 Prevents invoice deletion when chase_log records reference it (7.3842ms)
    ✔ 3.5 Prevents orphan accounting_connections: non-existent client_id throws foreign key failure (7.95ms)
  ✔ 3. Foreign Key Constraint Stress (PRAGMA foreign_keys = ON) (36.4432ms)
  ▶ 4. Unique Tenant Constraint Stress (UNIQUE (client_id, invoice_number))
    ✔ 4.1 Duplicate (client_id, invoice_number) within same client is rejected with UNIQUE constraint violation (7.0612ms)
    ✔ 4.2 Identical invoice_number across different clients succeeds (tenant isolation) (6.9042ms)
    ✔ 4.3 Updating an invoice number to collide with an existing invoice in the same client is rejected (6.1101ms)
    ✔ 4.4 Accounting connections UNIQUE (client_id, provider) prevents duplicate provider connections per tenant (9.331ms)
  ✔ 4. Unique Tenant Constraint Stress (UNIQUE (client_id, invoice_number)) (29.7671ms)
  ▶ 5. Domain CHECK Constraints & Data Integrity Stress
    ✔ 5.1 Invoices table CHECK (amount_pence > 0) rejects zero or negative amounts (8.3634ms)
    ✔ 5.2 Invoices table status CHECK constraint rejects invalid status values (7.0566ms)
    ✔ 5.3 Chase log status CHECK constraint strictly restricts values to ('draft', 'sent', 'skipped') (10.6846ms)
  ✔ 5. Domain CHECK Constraints & Data Integrity Stress (26.4435ms)
✔ Milestone M4 Stress Suite — Challenger 2 (D1 Query Indexing, Migrations & Constraint Stress) (157.1889ms)
ℹ tests 21
ℹ suites 6
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 642.8018
```

---

## 3. Overall Test & Verification Gate Summary

| Gate Check | Command | Result | Notes |
|------------|---------|--------|-------|
| Static Typecheck | `npm run typecheck` | PASS (0 errors) | Strict TypeScript compiler clean |
| Automated Test Suite | `npm test` | PASS (519/519 passed) | 113 suites passed across 8.45s |
| Dry-Run Edge Build | `npm run build` | PASS (0 errors) | 121.10 KiB (gzip 26.31 KiB), all bindings resolved |
| D1 Migration Apply | `npx wrangler d1 migrations apply ...` | PASS | Status `✅ No migrations to apply!` |
| SQLite Integrity Check | `PRAGMA integrity_check;` | PASS (`ok`) | Zero corruption detected |

---

## 4. Final Verdict

**Verdict**: **APPROVE**

The D1 database migration and query indexing implementation for Milestone M4 satisfies all performance, integrity, and idempotency criteria. No defects, regressions, or schema vulnerabilities were found.
