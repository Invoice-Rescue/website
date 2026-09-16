# Multi-Tenant Data Architecture & Repository Design (Milestone M1 / R1)

**Investigator:** M1 Tenancy DB Explorer  
**Date:** 2026-09-16  
**Status:** Authoritative Architectural Recommendation  
**Target Runtime:** Cloudflare Workers, Cloudflare D1 SQLite, Web Crypto API  
**Target Codebase Location:** `backend/src/lib/tenant-repo.ts` (with exports in `backend/src/lib/db.ts`)  

---

## 1. Executive Summary

Milestone M1 (R1: Multi-Tenant Data Architecture & Accounting Synchronization) requires an ironclad, leak-proof data repository layer isolating tenant organizations across all query, ingestion, webhook, and management workflows.

In Invoice Rescue, a **tenant** corresponds to a creditor client organization (`clients.id`). Every debtor invoice (`invoices`), every chase audit log entry (`chase_log`), and every accounting integration credential (`accounting_connections`) belongs strictly to one tenant.

### Core Architectural Findings:
1. **Schema Integrity Exists at the D1 SQLite Level**:
   - Schema migrations (`0001` to `0006`) enforce referential integrity (`REFERENCES clients(id)`), column CHECK constraints, and a composite uniqueness constraint `UNIQUE (client_id, invoice_number)`.
2. **Application Layer Lacks a Centralized Repository Abstraction**:
   - Queries across `backend/src/index.ts` and `backend/src/lib/portal.ts` currently rely on ad-hoc SQL strings.
   - There is no compile-time or runtime barrier preventing a query from accidentally omitting `WHERE client_id = ?1`.
   - Mutations on `chase_log` in `/api/chase/:id/approve` and `/api/chase/:id/skip` operate directly on `chase_log.id` without validating tenant boundaries or recording client context.
   - CSV import in `handleInvoiceImport` uses plain `INSERT INTO invoices`, which will crash on duplicates with an unhandled `SQLITE_CONSTRAINT_UNIQUE` exception rather than performing an idempotent upsert.
3. **Accounting Sync & Webhook Ingestion Needs Tenant Context Resolution**:
   - Incoming webhooks from Xero and QuickBooks identify the creditor organization by `tenant_id` (Xero) or `realmId` (QuickBooks).
   - Ingestion routines require a trusted connection resolver that maps `(provider, tenant_id)` to `client_id` before instantiating a tenant-scoped repository.
4. **Zero-Dependency Native Testing Strategy via `node:sqlite`**:
   - The test environment runs Node v25.9.0, which features native `node:sqlite` (`DatabaseSync`).
   - We can construct a zero-dependency in-memory D1 test adapter that executes migrations `0001` through `0006` to test tenant isolation, foreign keys, and unique constraint handling with 100% fidelity in `npm test`.

---

## 2. Comprehensive Schema & Migration Analysis (0001 to 0006)

### 2.1 Entity Relationship Diagram

```
+-----------------------------------------------------------------------------------------+
|                                    TENANT BOUNDARY                                      |
|                                                                                         |
|   +---------------------------------------------------------------------------------+   |
|   |                                     CLIENTS                                     |   |
|   |  id (PK)                                                                        |   |
|   |  company_name, contact_name, contact_email                                      |   |
|   |  plan: 'foundation' | 'engine' | 'operator'                                     |   |
|   |  status: 'onboarding' | 'active' | 'paused' | 'churned'                         |   |
|   |  accounting_source: 'xero' | 'quickbooks' | 'csv' | NULL                        |   |
|   |  voice_notes, stripe_customer_id, created_at                                    |   |
|   +---------------------------------------------------------------------------------+   |
|            |                                                         |                  |
|            | 1:N                                                     | 1:N              |
|            v                                                         v                  |
|   +---------------------------------------+       +---------------------------------+   |
|   |               INVOICES                |       |     ACCOUNTING_CONNECTIONS      |   |
|   |  id (PK)                              |       |  id (PK)                        |   |
|   |  client_id (FK -> clients.id)         |       |  client_id (FK -> clients.id)   |   |
|   |  debtor_name, debtor_email            |       |  provider: 'xero'|'quickbooks'  |   |
|   |  invoice_number                       |       |  tenant_id (Xero GUID / QBO ID) |   |
|   |  amount_pence (> 0), currency ('GBP') |       |  access_token_encrypted         |   |
|   |  issued_date, due_date                |       |  refresh_token_encrypted        |   |
|   |  status: 'overdue'|'promised'|'paid'| |       |  expires_at, last_synced_at     |   |
|   |          'disputed'|'escalated'       |       |  status: 'active'|'expired'|    |   |
|   |  paid_date, external_id               |       |          'revoked'              |   |
|   |  created_at, last_synced_at           |       |  UNIQUE(client_id, provider)    |   |
|   |  UNIQUE(client_id, invoice_number)    |       +---------------------------------+   |
|   +---------------------------------------+                                             |
|            |                                                                            |
|            | 1:N                                                                        |
|            v                                                                            |
|   +---------------------------------------+       +---------------------------------+   |
|   |               CHASE_LOG               |       |    ACCOUNTING_WEBHOOK_EVENTS    |   |
|   |  id (PK)                              |       |  id (PK, provider event ID)     |   |
|   |  invoice_id (FK -> invoices.id)       |       |  provider: 'xero'|'quickbooks'  |   |
|   |  step (1..4), channel ('email')       |       |  event_type                     |   |
|   |  subject, body                        |       |  payload                        |   |
|   |  outcome: 'sent'|'replied'|'promised' |       |  processed_at                   |   |
|   |           'paid'|'bounced'|NULL       |       +---------------------------------+   |
|   |  status: 'draft'|'sent'|'skipped'     |                                             |
|   |  sent_at, reviewed_at, reviewed_by    |                                             |
|   +---------------------------------------+                                             |
+-----------------------------------------------------------------------------------------+
```

### 2.2 Migration Breakdown & Constraints

| Migration | Key Modifications & Constraints | Multi-Tenant Significance |
|---|---|---|
| `0001_initial_schema.sql` | Baseline tables: `leads`, `clients`, `invoices`, `chase_log`. Foreign keys `invoices.client_id -> clients(id)` and `chase_log.invoice_id -> invoices(id)`. | Establishes the relational chain: Client -> Invoices -> Chase Log. |
| `0002_credit_control.sql` | Adds `invoices.external_id`, `invoices.last_synced_at`, `chase_log.body`, `chase_log.status`, `chase_log.reviewed_at`, `clients.voice_notes`. | Prepares `invoices` for external accounting synchronization. |
| `0003_add_check_constraints.sql` | Rebuilds tables to enforce SQLite CHECK constraints and adds **`UNIQUE (client_id, invoice_number)`**. | **The foundational tenant constraint.** Allows Client A and Client B to both have `INV-001`, while strictly preventing duplicate invoice imports within the same client. |
| `0004_client_portal_and_billing.sql` | Adds `clients.stripe_customer_id`, `chase_log.reviewed_by`. | Supports tenant-specific Stripe billing portal and audit trail. |
| `0005_webhook_events.sql` | Adds `webhook_events (id PRIMARY KEY, event_type, customer_id, created_at_timestamp, processed_at)` for Stripe. | Implements Stripe webhook idempotency. |
| `0006_accounting_connections_and_external_sync.sql` | Adds `accounting_connections` with `UNIQUE (client_id, provider)` and `accounting_webhook_events (id PRIMARY KEY, provider, event_type, payload)`. | Houses encrypted OAuth credentials per tenant and provides accounting webhook idempotency. |

### 2.3 Identified Schema Gaps & Optimization Recommendations

1. **Missing Index on Accounting Connection Tenant ID**:
   - Query: When a webhook from Xero or QuickBooks arrives, the payload contains `tenantId` / `realmId`.
   - In D1, resolving which client owns that connection requires:
     `SELECT client_id FROM accounting_connections WHERE provider = ?1 AND tenant_id = ?2`.
   - Current index: `idx_accounting_connections_client_provider` covers `(client_id, provider)`.
   - *Recommendation*: In query design, query by `(provider, tenant_id)`. Recommend a future migration `0007` to add `CREATE INDEX IF NOT EXISTS idx_accounting_connections_provider_tenant ON accounting_connections (provider, tenant_id)`.
2. **Missing Direct Client Reference on `chase_log`**:
   - `chase_log` references `invoice_id`, not `client_id`.
   - Any multi-tenant query on `chase_log` must join `invoices i ON i.id = cl.invoice_id WHERE i.client_id = ?1`.
   - *Design mandate*: The repository must encapsulate this join so callers never risk querying `chase_log` without tenant scoping.
3. **No Direct `external_id` Index on `invoices`**:
   - Provider webhooks reference the provider's internal invoice ID (`external_id`).
   - Searching by `(client_id, external_id)` will scan invoices for that client. Because `idx_invoices_client` exists on `client_id`, SQLite will filter on `client_id` first (fast for a single tenant), but an index on `(client_id, external_id)` would provide instant O(1) lookups during sync.

---

## 3. Current Query Pattern Audit & Vulnerability Analysis

An inspection of `backend/src/index.ts` reveals several critical security and integrity vulnerabilities:

### 3.1 Vulnerability 1: Unhandled Unique Constraint Violation on CSV Import
- **Location:** `backend/src/index.ts:434-450` (`handleInvoiceImport`)
- **Observation:**
  ```typescript
  await env.DB.prepare(
    `INSERT INTO invoices
       (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, external_id, last_synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'overdue', NULL, datetime('now'))`
  ).bind(clientId, debtorName, ...).run();
  ```
- **Risk:** If a client re-uploads a CSV containing previously imported invoice numbers, or if an import script runs twice, SQLite aborts with:
  `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: invoices.client_id, invoices.invoice_number`
  This crashes the batch import halfway through, leaving the database in an inconsistent state.
- **Remediation:** Replace with an atomic `INSERT ... ON CONFLICT(client_id, invoice_number) DO UPDATE` query in the tenant repository.

### 3.2 Vulnerability 2: Missing Tenant Scoping on Chase Actions
- **Location:** `backend/src/index.ts:471-527` (`handleChaseApprove` and `handleChaseSkip`)
- **Observation:**
  ```typescript
  const row = await env.DB.prepare(
    `SELECT cl.id, cl.body, cl.subject, i.debtor_email, i.invoice_number
     FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id
     WHERE cl.id = ?1 AND cl.status = 'draft'`
  ).bind(chaseId).first();
  ```
- **Risk:** The query filters only on `cl.id = ?1`. It does NOT verify `i.client_id`. If exposed to authenticated clients in the portal (as planned for Milestone M3 review queue), any tenant could approve, modify, or skip drafts belonging to other tenants by guessing or incrementing `chaseId`.
- **Remediation:** Enforce `WHERE cl.id = ?1 AND i.client_id = ?2` across all chase mutations and approvals.

### 3.3 Vulnerability 3: Risk of Un-paying Settled Invoices during External Sync
- **Location:** Accounting Ingestion / Sync Logic
- **Observation:** When accounting data is synchronized (from Xero, QuickBooks, or CSV), an external invoice status might lag behind reality or arrive with stale information.
- **Risk:** If an invoice was settled (`status = 'paid'`, `paid_date = '2026-09-01'`) either manually or via webhook, a bulk re-sync from an accounting sync snapshot must never revert the invoice to `'overdue'`, as that would trigger illegal late-payment escalation under the 1998 Act!
- **Remediation:** The SQL `ON CONFLICT` clause must include conditional protection:
  `status = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE excluded.status END`.

---

## 4. Tenant-Isolated Data Repository Design (`tenant-repo.ts`)

To resolve these vulnerabilities and satisfy PROJECT.md §1, we design a dedicated data repository layer.

### 4.1 Architecture Strategy: Dual-Interface Pattern

We recommend structuring `backend/src/lib/tenant-repo.ts` to provide:
1. **The Exact Functional Interface Specified in `PROJECT.md` §1**:
   Direct functions accepting `(db: D1Database, clientId: number, ...)` for seamless drop-in compatibility.
2. **An Object-Oriented Scoped Repository (`TenantRepository`)**:
   An instantiated class constructed via `new TenantRepository(db, clientId)`. Once instantiated, the instance permanently encapsulates `clientId`, making it impossible for any consumer (such as `SyncService` or route handlers) to omit or alter the tenant boundary.

### 4.2 Data Types & Interfaces

```typescript
export type InvoiceStatus = 'overdue' | 'promised' | 'disputed' | 'paid' | 'escalated';
export type AccountingProvider = 'xero' | 'quickbooks';
export type ConnectionStatus = 'active' | 'expired' | 'revoked';

export interface TenantInvoice {
  id: number;
  clientId: number;
  debtorName: string;
  debtorEmail: string | null;
  invoiceNumber: string;
  amountPence: number;
  currency: string;
  issuedDate: string | null;
  dueDate: string;
  status: InvoiceStatus;
  paidDate: string | null;
  createdAt: string;
  externalId: string | null;
  lastSyncedAt: string | null;
}

export interface UpsertInvoiceInput {
  debtorName: string;
  debtorEmail?: string | null;
  invoiceNumber: string;
  amountPence: number;
  currency?: string;
  issuedDate?: string | null;
  dueDate: string;
  status?: InvoiceStatus;
  externalId?: string | null;
}

export interface UpsertInvoiceResult {
  action: 'inserted' | 'updated';
  invoiceNumber: string;
}

export interface TenantChaseDraft {
  id: number;
  invoiceId: number;
  step: number;
  channel: string;
  subject: string | null;
  body: string | null;
  status: 'draft' | 'sent' | 'skipped';
  sentAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  invoiceNumber: string;
  debtorName: string;
  debtorEmail: string | null;
  amountPence: number;
}

export interface TenantAccountingConnection {
  id: number;
  clientId: number;
  provider: AccountingProvider;
  tenantId: string | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  expiresAt: string;
  lastSyncedAt: string | null;
  status: ConnectionStatus;
  createdAt: string;
}
```

### 4.3 Concrete Method Signatures & SQL Implementations

#### 1. `getTenantInvoices(db: D1Database, clientId: number): Promise<TenantInvoice[]>`
Retrieves all invoices strictly scoped to `clientId`:
```typescript
export async function getTenantInvoices(db: D1Database, clientId: number): Promise<TenantInvoice[]> {
  validateClientId(clientId);
  const rows = await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1
     ORDER BY due_date DESC`
  ).bind(clientId).all<TenantInvoice>();

  return rows.results ?? [];
}
```

#### 2. `getTenantInvoiceByNumber(db: D1Database, clientId: number, invoiceNumber: string): Promise<TenantInvoice | null>`
Fetches a single invoice by its tenant-scoped number:
```typescript
export async function getTenantInvoiceByNumber(
  db: D1Database,
  clientId: number,
  invoiceNumber: string
): Promise<TenantInvoice | null> {
  validateClientId(clientId);
  if (!invoiceNumber || typeof invoiceNumber !== 'string') return null;

  return await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1 AND invoice_number = ?2`
  ).bind(clientId, invoiceNumber.trim()).first<TenantInvoice>();
}
```

#### 3. `getTenantInvoiceById(db: D1Database, clientId: number, invoiceId: number): Promise<TenantInvoice | null>`
Fetches a single invoice by its primary key, strictly validating tenant ownership:
```typescript
export async function getTenantInvoiceById(
  db: D1Database,
  clientId: number,
  invoiceId: number
): Promise<TenantInvoice | null> {
  validateClientId(clientId);
  validateIntegerId(invoiceId, 'invoiceId');

  return await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1 AND id = ?2`
  ).bind(clientId, invoiceId).first<TenantInvoice>();
}
```

#### 4. `upsertTenantInvoice(db: D1Database, clientId: number, invoice: UpsertInvoiceInput): Promise<UpsertInvoiceResult>`
Guarantees atomic, idempotent insert/update respecting `UNIQUE (client_id, invoice_number)` and protecting settled invoices:
```typescript
export async function upsertTenantInvoice(
  db: D1Database,
  clientId: number,
  invoice: UpsertInvoiceInput
): Promise<UpsertInvoiceResult> {
  validateClientId(clientId);
  validateInvoiceInput(invoice);

  const status = invoice.status || 'overdue';
  const currency = invoice.currency || 'GBP';
  const debtorEmail = invoice.debtorEmail ? invoice.debtorEmail.trim() : null;
  const issuedDate = invoice.issuedDate ? invoice.issuedDate.trim() : null;
  const externalId = invoice.externalId ? invoice.externalId.trim() : null;

  // Determine whether this will be an insert or update
  const existing = await db.prepare(
    `SELECT id, status FROM invoices WHERE client_id = ?1 AND invoice_number = ?2`
  ).bind(clientId, invoice.invoiceNumber.trim()).first<{ id: number; status: string }>();

  await db.prepare(
    `INSERT INTO invoices (
       client_id, debtor_name, debtor_email, invoice_number,
       amount_pence, currency, issued_date, due_date, status,
       paid_date, external_id, last_synced_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       CASE WHEN ?9 = 'paid' THEN date('now') ELSE NULL END,
       ?10, datetime('now')
     )
     ON CONFLICT(client_id, invoice_number) DO UPDATE SET
       debtor_name = excluded.debtor_name,
       debtor_email = COALESCE(excluded.debtor_email, invoices.debtor_email),
       amount_pence = excluded.amount_pence,
       currency = excluded.currency,
       due_date = excluded.due_date,
       issued_date = COALESCE(excluded.issued_date, invoices.issued_date),
       external_id = COALESCE(excluded.external_id, invoices.external_id),
       status = CASE 
         WHEN invoices.status = 'paid' THEN 'paid'
         WHEN excluded.status = 'paid' THEN 'paid'
         ELSE excluded.status 
       END,
       paid_date = CASE 
         WHEN invoices.status = 'paid' THEN invoices.paid_date
         WHEN excluded.status = 'paid' AND invoices.paid_date IS NULL THEN date('now')
         ELSE invoices.paid_date 
       END,
       last_synced_at = datetime('now')`
  ).bind(
    clientId,
    invoice.debtorName.trim(),
    debtorEmail,
    invoice.invoiceNumber.trim(),
    invoice.amountPence,
    currency,
    issuedDate,
    invoice.dueDate.trim(),
    status,
    externalId
  ).run();

  return {
    action: existing ? 'updated' : 'inserted',
    invoiceNumber: invoice.invoiceNumber.trim(),
  };
}
```

#### 5. `recordAccountingWebhook(db: D1Database, eventId: string, provider: AccountingProvider, payload: unknown): Promise<boolean>`
Enforces cryptographic webhook idempotency, deduplication, and audit logging:
```typescript
export async function recordAccountingWebhook(
  db: D1Database,
  eventId: string,
  provider: AccountingProvider,
  payload: unknown
): Promise<boolean> {
  if (!eventId || typeof eventId !== 'string') {
    throw new InvalidWebhookEventError('Missing or invalid eventId');
  }
  if (provider !== 'xero' && provider !== 'quickbooks') {
    throw new InvalidWebhookEventError(`Unsupported accounting provider: ${provider}`);
  }

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  // SQLite INSERT OR IGNORE returns meta.changes = 0 if the primary key exists
  const res = await db.prepare(
    `INSERT OR IGNORE INTO accounting_webhook_events (id, provider, event_type, payload, processed_at)
     VALUES (?1, ?2, 'webhook_event', ?3, datetime('now'))`
  ).bind(eventId.trim(), provider, payloadString).run();

  // If changes === 1, event is new; if changes === 0, event was a duplicate
  return (res.meta?.changes ?? 0) > 0;
}
```

#### 6. `getAccountingConnection(db: D1Database, clientId: number, provider: AccountingProvider): Promise<TenantAccountingConnection | null>`
Retrieves connection tokens scoped to `clientId`:
```typescript
export async function getAccountingConnection(
  db: D1Database,
  clientId: number,
  provider: AccountingProvider
): Promise<TenantAccountingConnection | null> {
  validateClientId(clientId);
  return await db.prepare(
    `SELECT id, client_id AS clientId, provider, tenant_id AS tenantId,
            access_token_encrypted AS accessTokenEncrypted,
            refresh_token_encrypted AS refreshTokenEncrypted,
            expires_at AS expiresAt, last_synced_at AS lastSyncedAt,
            status, created_at AS createdAt
     FROM accounting_connections
     WHERE client_id = ?1 AND provider = ?2`
  ).bind(clientId, provider).first<TenantAccountingConnection>();
}
```

#### 7. `upsertAccountingConnection(...)`:
Atomically connects or rotates tokens for a tenant:
```typescript
export async function upsertAccountingConnection(
  db: D1Database,
  clientId: number,
  conn: {
    provider: AccountingProvider;
    tenantId?: string | null;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    expiresAt: string;
    status?: ConnectionStatus;
  }
): Promise<void> {
  validateClientId(clientId);
  await db.prepare(
    `INSERT INTO accounting_connections (
       client_id, provider, tenant_id, access_token_encrypted,
       refresh_token_encrypted, expires_at, last_synced_at, status, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7, datetime('now'))
     ON CONFLICT(client_id, provider) DO UPDATE SET
       tenant_id = COALESCE(excluded.tenant_id, accounting_connections.tenant_id),
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       expires_at = excluded.expires_at,
       last_synced_at = datetime('now'),
       status = excluded.status`
  ).bind(
    clientId,
    conn.provider,
    conn.tenantId ?? null,
    conn.accessTokenEncrypted,
    conn.refreshTokenEncrypted,
    conn.expiresAt,
    conn.status ?? 'active'
  ).run();
}
```

#### 8. `resolveClientByAccountingTenant(...)`:
Resolves external provider tenant ID to internal `clientId`:
```typescript
export async function resolveClientByAccountingTenant(
  db: D1Database,
  provider: AccountingProvider,
  tenantId: string
): Promise<number | null> {
  if (!tenantId || typeof tenantId !== 'string') return null;

  const row = await db.prepare(
    `SELECT client_id AS clientId
     FROM accounting_connections
     WHERE provider = ?1 AND tenant_id = ?2 AND status = 'active'`
  ).bind(provider, tenantId.trim()).first<{ clientId: number }>();

  return row ? row.clientId : null;
}
```

#### 9. Chase Draft Management Scoped to Tenant
```typescript
export async function getTenantDrafts(db: D1Database, clientId: number): Promise<TenantChaseDraft[]> {
  validateClientId(clientId);
  const rows = await db.prepare(
    `SELECT cl.id, cl.invoice_id AS invoiceId, cl.step, cl.channel, cl.subject, cl.body,
            cl.status, cl.sent_at AS sentAt, cl.reviewed_at AS reviewedAt, cl.reviewed_by AS reviewedBy,
            i.invoice_number AS invoiceNumber, i.debtor_name AS debtorName, i.debtor_email AS debtorEmail,
            i.amount_pence AS amountPence
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     WHERE i.client_id = ?1 AND cl.status = 'draft'
     ORDER BY cl.sent_at ASC`
  ).bind(clientId).all<TenantChaseDraft>();

  return rows.results ?? [];
}

export async function approveTenantDraft(
  db: D1Database,
  clientId: number,
  draftId: number,
  editedBody: string,
  reviewedBy: string
): Promise<boolean> {
  validateClientId(clientId);
  validateIntegerId(draftId, 'draftId');

  const res = await db.prepare(
    `UPDATE chase_log
     SET status = 'sent',
         body = ?3,
         outcome = 'sent',
         reviewed_at = datetime('now'),
         reviewed_by = ?4
     WHERE id = ?1
       AND status = 'draft'
       AND invoice_id IN (SELECT id FROM invoices WHERE client_id = ?2)`
  ).bind(draftId, clientId, editedBody, reviewedBy).run();

  return (res.meta?.changes ?? 0) > 0;
}

export async function skipTenantDraft(
  db: D1Database,
  clientId: number,
  draftId: number
): Promise<boolean> {
  validateClientId(clientId);
  validateIntegerId(draftId, 'draftId');

  const res = await db.prepare(
    `UPDATE chase_log
     SET status = 'skipped',
         reviewed_at = datetime('now')
     WHERE id = ?1
       AND status = 'draft'
       AND invoice_id IN (SELECT id FROM invoices WHERE client_id = ?2)`
  ).bind(draftId, clientId).run();

  return (res.meta?.changes ?? 0) > 0;
}
```

---

## 5. Boundary Validation & Error Handling Strategy

### 5.1 Zero-Dependency Boundary Validation Guards

To adhere to **Rule 2 (Clean code: boundary validation)** and **R4 (Zero external runtime dependencies)**, validation is implemented using TypeScript guard clauses and assertion functions:

```typescript
export function validateClientId(clientId: unknown): asserts clientId is number {
  if (typeof clientId !== 'number' || !Number.isInteger(clientId) || clientId <= 0) {
    throw new InvalidTenantError(`Invalid tenant client_id: ${clientId}`);
  }
}

export function validateIntegerId(id: unknown, fieldName: string): asserts id is number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new InvalidInputError(`Invalid ${fieldName}: ${id}`);
  }
}

export function validateInvoiceInput(input: UpsertInvoiceInput): void {
  if (!input || typeof input !== 'object') {
    throw new InvalidInvoiceDataError('Invoice input must be a non-null object');
  }
  if (!input.debtorName || typeof input.debtorName !== 'string' || input.debtorName.trim().length < 2) {
    throw new InvalidInvoiceDataError('debtorName must be at least 2 characters');
  }
  if (!input.invoiceNumber || typeof input.invoiceNumber !== 'string' || input.invoiceNumber.trim().length < 1) {
    throw new InvalidInvoiceDataError('invoiceNumber is required');
  }
  if (typeof input.amountPence !== 'number' || !Number.isInteger(input.amountPence) || input.amountPence <= 0) {
    throw new InvalidInvoiceDataError('amountPence must be a positive integer in pence');
  }
  if (!input.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate.trim())) {
    throw new InvalidInvoiceDataError('dueDate must be a valid ISO date string (YYYY-MM-DD)');
  }
  if (input.debtorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.debtorEmail.trim())) {
    throw new InvalidInvoiceDataError(`Invalid debtor email: ${input.debtorEmail}`);
  }
  if (input.status) {
    const validStatuses = new Set(['overdue', 'promised', 'disputed', 'paid', 'escalated']);
    if (!validStatuses.has(input.status)) {
      throw new InvalidInvoiceDataError(`Invalid invoice status: ${input.status}`);
    }
  }
}
```

### 5.2 Typed Error Hierarchy

```typescript
export abstract class TenantRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidTenantError extends TenantRepositoryError {}
export class TenantBoundaryViolationError extends TenantRepositoryError {}
export class InvoiceNotFoundError extends TenantRepositoryError {}
export class InvalidInvoiceDataError extends TenantRepositoryError {}
export class InvalidWebhookEventError extends TenantRepositoryError {}
export class InvalidInputError extends TenantRepositoryError {}
```

---

## 6. Integration Architecture with Worker, OAuth & SyncService

### 6.1 Worker Route Scoping (`backend/src/index.ts`)

```typescript
// Example: Client Portal Dashboard
async function handlePortalDashboard(request: Request, env: Env): Promise<Response> {
  const clientId = await authenticateClient(request, env.PORTAL_SESSION_SECRET);
  if (clientId === null) {
    return new Response(null, { status: 303, headers: { Location: "/portal" } });
  }

  const repo = new TenantRepository(env.DB, clientId);
  const invoices = await repo.getInvoices();
  const drafts = await repo.getDrafts();
  ...
}

// Example: CSV Import Route
async function handleInvoiceImport(request: Request, env: Env, clientIdParam: string): Promise<Response> {
  const clientId = Number(clientIdParam);
  validateClientId(clientId);

  const repo = new TenantRepository(env.DB, clientId);
  const rows = parseCsv(await request.text());
  
  const results = [];
  for (const row of rows) {
    const res = await repo.upsertInvoice({
      debtorName: row.debtor_name,
      debtorEmail: row.debtor_email,
      invoiceNumber: row.invoice_number,
      amountPence: Math.round(Number(row.amount) * 100),
      currency: row.currency || 'GBP',
      issuedDate: row.issued_date,
      dueDate: row.due_date,
      status: 'overdue',
    });
    results.push(res);
  }
  return Response.json({ ok: true, imported: results.length });
}
```

### 6.2 Accounting SyncService Integration (`backend/src/lib/integrations/sync-service.ts`)

```typescript
export class SyncService {
  constructor(private db: D1Database, private env: Env) {}

  async syncTenantInvoices(clientId: number): Promise<SyncResult> {
    const repo = new TenantRepository(this.db, clientId);
    const connection = await repo.getAccountingConnection('xero') 
                    ?? await repo.getAccountingConnection('quickbooks');
    
    if (!connection || connection.status !== 'active') {
      return { success: false, reason: 'No active connection' };
    }

    // Decrypt token, query provider API, reconcile
    const externalInvoices = await fetchProviderInvoices(connection, this.env);
    
    let synced = 0;
    for (const ext of externalInvoices) {
      await repo.upsertInvoice({
        debtorName: ext.contactName,
        debtorEmail: ext.contactEmail,
        invoiceNumber: ext.invoiceNumber,
        amountPence: ext.amountDuePence,
        currency: ext.currencyCode,
        issuedDate: ext.date,
        dueDate: ext.dueDate,
        status: ext.isPaid ? 'paid' : 'overdue',
        externalId: ext.invoiceId,
      });
      synced++;
    }
    return { success: true, synced };
  }
}
```

### 6.3 Webhook Ingestion Pipeline

```
[Incoming Webhook POST]
         │
         ▼
[1. Verify HMAC Signature (webhooks.ts)]
   - Xero: x-xero-signature
   - QuickBooks: intuit-signature
         │ (reject 401 if invalid)
         ▼
[2. Deduplicate Event (recordAccountingWebhook)]
   - INSERT OR IGNORE INTO accounting_webhook_events
         │ (if duplicate: return 200 { ok: true, duplicate: true })
         ▼
[3. Resolve Tenant (resolveClientByAccountingTenant)]
   - Map payload tenant_id / realmId -> clientId
         │ (if tenant unknown: return 200 { ok: true, unmapped: true })
         ▼
[4. Instantiate Scoped TenantRepository(db, clientId)]
         │
         ▼
[5. Reconcile Invoices Idempotently (upsertTenantInvoice)]
   - Update paid status, stamp paid_date, or update balances
```

---

## 7. Test Verification Strategy & Specification

### 7.1 Zero-Dependency `node:sqlite` In-Memory D1 Shim

Because Node v25.9.0 has built-in `node:sqlite`, we can create a fast, deterministic, in-memory D1 test fixture (`tests/helpers/test-d1.ts`) without adding external npm packages:

```typescript
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function createTestD1Database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  
  // Apply migrations 0001 through 0006 in order
  const migrationFiles = [
    '0001_initial_schema.sql',
    '0002_credit_control.sql',
    '0003_add_check_constraints.sql',
    '0004_client_portal_and_billing.sql',
    '0005_webhook_events.sql',
    '0006_accounting_connections_and_external_sync.sql',
  ];

  for (const file of migrationFiles) {
    const sql = readFileSync(join(process.cwd(), 'backend/db/migrations', file), 'utf-8');
    sqlite.exec(sql);
  }

  // Wrap sqlite in D1Database interface
  return {
    prepare(query: string) {
      return {
        bind(...params: any[]) {
          return {
            async first<T>(): Promise<T | null> {
              const stmt = sqlite.prepare(query);
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const stmt = sqlite.prepare(query);
              return { results: (stmt.all(...params) as T[]) ?? [] };
            },
            async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
              const stmt = sqlite.prepare(query);
              const info = stmt.run(...params);
              return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
```

### 7.2 Multi-Tenant Test Suite Specifications (`tests/tenant-repo.test.ts`)

| # | Test Case | Target Invariant | Expected Behavior |
|---|---|---|---|
| 1 | `Cross-Tenant Read Isolation` | `getTenantInvoices` | Tenant A queries invoices; returns only Tenant A records. Zero Tenant B records visible. |
| 2 | `Invoice Number Conflict Isolation` | `UNIQUE (client_id, invoice_number)` | Tenant A and Tenant B can both create invoice `INV-001` with different debtors and amounts without collision. |
| 3 | `Same-Tenant Duplicate Upsert` | Idempotent Upsert | Calling `upsertTenantInvoice` twice for Tenant A with `INV-001` updates debtor/amount without throwing `SQLITE_CONSTRAINT_UNIQUE` and without duplicating rows. |
| 4 | `Settled Invoice Protection` | State Machine Invariant | An invoice with `status = 'paid'` cannot be reverted to `'overdue'` by an external sync upsert. |
| 5 | `Cross-Tenant Invoice Mutation Guard` | Single Invoice Isolation | Tenant A attempting to fetch or update Tenant B's invoice ID returns `null` / 0 changes. |
| 6 | `Cross-Tenant Draft Mutation Guard` | `approveTenantDraft` | Attempting to approve a draft using Tenant A's `clientId` where the draft belongs to Tenant B fails (0 rows updated). |
| 7 | `Webhook Idempotency & Deduplication` | `recordAccountingWebhook` | First call with event ID returns `true`; immediate second call returns `false`. |
| 8 | `Tenant Connection Resolution` | `resolveClientByAccountingTenant` | Successfully resolves Xero `tenant_id` and QuickBooks `realmId` to the correct `clientId`. Returns `null` for unknown or revoked connections. |
| 9 | `Strict Client ID Validation` | Fail-closed input validation | Passing negative, zero, float, or string `clientId` immediately throws `InvalidTenantError`. |

---

## 8. Summary of Architectural Recommendations for Milestone M1

1. **Implement `backend/src/lib/tenant-repo.ts`**:
   - Provide the standalone methods requested in `PROJECT.md` §1:
     - `getTenantInvoices`
     - `getTenantInvoiceByNumber`
     - `upsertTenantInvoice`
     - `recordAccountingWebhook`
   - Provide the `TenantRepository` class for clean object-oriented usage in services and routes.
2. **Re-export Repository from `backend/src/lib/db.ts`**:
   - Centralize all database operations in `db.ts` and `tenant-repo.ts`.
3. **Refactor Ingestion & Admin Endpoints in `backend/src/index.ts`**:
   - Use `upsertTenantInvoice` in `handleInvoiceImport` to eliminate the CSV duplicate crash bug.
   - Enforce `WHERE client_id = ?` in all draft queries and mutations.
4. **Mount Webhook & Sync Routes with Connection Resolver**:
   - Implement `POST /api/webhooks/xero` and `POST /api/webhooks/quickbooks`.
   - Resolve `clientId` via `resolveClientByAccountingTenant`.
   - Process events through `TenantRepository`.
5. **Add Comprehensive Isolation Tests in `tests/tenant-repo.test.ts`**:
   - Use the `node:sqlite` in-memory test harness to prove 100% compliance with zero regressions.
