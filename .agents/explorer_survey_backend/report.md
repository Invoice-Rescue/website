# Comprehensive Backend Architecture Survey & Gap Analysis (R1 & R4)

**Document:** Backend Architecture Survey  
**Date:** 2026-09-16  
**Investigator:** Backend Architecture Explorer  
**Target Project:** Invoice Rescue (`d:\Dev\Workspaces\Active\invoice-rescue`)  
**Scope:** R1 (Multi-Tenant Data Architecture & Accounting Synchronization) and R4 (Edge Infrastructure & Deliverability Controls)

---

## 1. Executive Summary

Invoice Rescue is an AI-assisted credit-control SaaS built on the Cloudflare Serverless Edge platform (Workers, D1 SQLite, and Pages static assets).

The backend infrastructure satisfies the core edge requirements of **R4**:
1. **Zero External Runtime Dependencies:** The production bundle has zero npm dependencies in `package.json` (`dependencies: {}`). All HTTP integrations (Stripe, Gemini) and cryptographic operations (AES-GCM, HMAC-SHA256) use native Web Platform standards (`fetch`, `crypto.subtle`, `URLSearchParams`).
2. **Cloudflare D1 Database:** D1 database (`invoice-rescue-db`, ID: `b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`) is managed via standard migration files (`backend/db/migrations/0001_initial_schema.sql` through `0006_accounting_connections_and_external_sync.sql`), applying cleanly and enforcing SQLite CHECK constraints.
3. **Split-Trust Email Routing:** Email bindings are isolated between restricted internal notifications (`NOTIFY` restricted to `tiborcc2@gmail.com`) and debtor/client outward delivery (`SEND` unrestricted destination).

However, **R1 (Multi-Tenant Data Architecture & Accounting Synchronization)** is currently only **partially implemented / scaffolded**:
- **AES-GCM 256-bit token encryption** (`backend/src/lib/integrations/oauth-manager.ts`) and **HMAC webhook verification** (`backend/src/lib/integrations/webhooks.ts`) are implemented and covered by unit tests (`tests/oauth.test.ts`, `tests/webhooks.test.ts`), but they are **not wired into the worker router** (`backend/src/index.ts`).
- **OAuth 2.0 connection lifecycle** for Xero and QuickBooks is completely missing from the API (no authorization endpoints, no callback handlers, no token refresh logic).
- **Accounting Sync Service** is a 6-line dummy stub (`backend/src/lib/integrations/sync-service.ts`), lacking invoice synchronization and idempotent deduplication.
- **Webhook endpoints** for Xero and QuickBooks (`/api/webhooks/xero`, `/api/webhooks/quickbooks`) do not exist in `backend/src/index.ts`.
- **Daily polling jobs** currently only evaluate overdue invoices already in D1 (`runOverdueDetection`), with zero accounting sync polling to ingest new/updated invoices from Xero or QuickBooks.
- **Tenant Isolation** exists at the data model level (`client_id` foreign keys, unique compound indexes) and in portal queries, but lacks a centralized repository/middleware enforcing tenant scoping across all ingestion and admin surfaces.

---

## 2. Edge Infrastructure & Cloudflare Worker Configuration (R4)

### 2.1 Worker Runtime & Build Configuration

- **Configuration File:** `wrangler.jsonc`
  - `name`: `"invoice-rescue"`
  - `main`: `"backend/src/index.ts"`
  - `compatibility_date`: `"2026-07-15"`
  - `compatibility_flags`: `["nodejs_compat"]`
  - `assets`:
    - `directory`: `"./frontend"`
    - `binding`: `"ASSETS"`
    - `run_worker_first`: `["/api/*", "/admin*", "/portal*"]` (static files under `/` and `/dashboard/*` served directly from `./frontend`)
  - `d1_databases`:
    - `binding`: `"DB"`
    - `database_name`: `"invoice-rescue-db"`
    - `database_id`: `"b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f"`
    - `migrations_dir`: `"./backend/db/migrations"`
  - `send_email`:
    - `NOTIFY`: `destination_address: "tiborcc2@gmail.com"` (operator inbox only)
    - `SEND`: Unrestricted destination
  - `triggers.crons`:
    - `"0 6 * * *"`: Daily overdue invoice detection and AI drafting
    - `"0 8 * * FRI"`: Weekly Friday cash report per active client

### 2.2 Dependency & Runtime Verification

- **Configuration File:** `package.json`
  - `dependencies`: None (`0` runtime packages).
  - `devDependencies`:
    - `@cloudflare/workers-types`: `^5.20260826.1`
    - `@types/node`: `^26.1.1`
    - `markdownlint-cli2`: `^0.23.2`
    - `tsx`: `^4.23.13`
    - `typescript`: `^7.0.2`
    - `wrangler`: `^4.126.0` (active version `4.131.0`)
- **Verification Commands Executed:**
  - `npm test`: **Pass** (31 passed, 0 failed across 6 test suites in 1.26s).
  - `npx tsc --noEmit`: **Pass** (0 type errors).
  - `npm run build` (`wrangler deploy --dry-run`): **Pass** (Clean dry-run bundle upload: 42.84 KiB).
  - `npx wrangler d1 migrations apply invoice-rescue-db --local`: **Pass** ("No migrations to apply").

### 2.3 Split-Trust Email Routing & Deliverability

- **Architecture:**
  - `env.NOTIFY` is bound strictly to `tiborcc2@gmail.com`. Used exclusively for operational alerts:
    - New lead alerts from `POST /api/lead` (`backend/src/index.ts:267-284`).
    - Operator review queue notifications from `runOverdueDetection` (`backend/src/index.ts:824-830`).
  - `env.SEND` has unrestricted destination permissions. Used for:
    - Client magic link logins (`handlePortalLoginRequest`, line 574).
    - Debtor chase emails upon operator approval (`handleChaseApprove`, line 503).
    - Client weekly Friday cash reports (`runFridayReport`, line 871).
- **Deliverability & Anti-Bot Controls:**
  - **Locked Sender Model:** Outbound emails enforce `FROM: hello@invoicerescue.co.uk` with sender name `"Invoice Rescue"` and sign-off by `"Tibor Rames, Invoice Rescue — acting on behalf of [Client Name]"`.
  - **Honeypot Anti-Bot:** `POST /api/lead` checks for the hidden `website` field (`backend/src/index.ts:247-250`); bot submissions silently return 200 without database insertion or email triggers.
  - **Security Headers:** All responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
  - **Deliverability Gaps Identified:**
    1. `/portal/login` has no rate-limiting or Cloudflare Turnstile verification.
    2. Cloudflare Email Routing does not natively post bounce webhooks back to the Worker; `chase_log.outcome` cannot transition from `'sent'` to `'bounced'` automatically.
    3. Outbound debtor emails lack automated unsubscribe/opt-out headers (relevant for PECR sole trader compliance).

---

## 3. Database Architecture & Schema Migrations (R1 & R4)

Migrations are located in `backend/db/migrations/`:

| Migration File | Purpose | Key Entities & Constraints |
| :--- | :--- | :--- |
| `0001_initial_schema.sql` | Baseline schema | `leads`, `clients`, `invoices`, `chase_log` |
| `0002_credit_control.sql` | Engine columns | `invoices.external_id`, `invoices.last_synced_at`, `chase_log.body`, `chase_log.status`, `chase_log.reviewed_at`, `clients.voice_notes` |
| `0003_add_check_constraints.sql` | DB integrity & constraints | CHECK constraints on `clients.plan`, `clients.status`, `clients.accounting_source`, `invoices.status`, `chase_log.status`, `chase_log.outcome`; `UNIQUE (client_id, invoice_number)` |
| `0004_client_portal_and_billing.sql` | Client portal link | `clients.stripe_customer_id`, `chase_log.reviewed_by` |
| `0005_webhook_events.sql` | Stripe idempotency | `webhook_events (id PRIMARY KEY, event_type, customer_id, created_at_timestamp, processed_at)` |
| `0006_accounting_connections_and_external_sync.sql` | Accounting integration tables | `accounting_connections`, `accounting_webhook_events` |

### 3.1 Detailed Schema Specifications

#### Table: `clients`
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

#### Table: `invoices`
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
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, due_date);
```

#### Table: `chase_log`
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
CREATE INDEX IF NOT EXISTS idx_chase_invoice ON chase_log(invoice_id);
```

#### Table: `accounting_connections` (Added in 0006)
```sql
CREATE TABLE IF NOT EXISTS accounting_connections (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_connections_client_provider 
  ON accounting_connections (client_id, provider);
```

#### Table: `accounting_webhook_events` (Added in 0006)
```sql
CREATE TABLE IF NOT EXISTS accounting_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')),
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 4. Current Worker Routing & Endpoint Inventory (`backend/src/index.ts`)

| HTTP Method | Route Path | Auth Requirement | Handler Function | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | `handleHealth(env)` | Probes DB via `SELECT 1` |
| `GET` | `/api/statutory-rate` | Public | Inline JSON | Returns `env.BOE_BASE_RATE_PERCENT` (3.75%) |
| `POST` | `/api/lead` | Public (Honeypot) | `handleLead(request, env)` | Validates and stores audit lead, alerts operator |
| `POST` | `/api/clients` | Admin (Basic Auth) | `handleCreateClient(request, env)` | Registers client in D1, provisions Stripe customer |
| `POST` | `/api/clients/:id/invoices/import` | Admin (Basic Auth) | `handleInvoiceImport(...)` | Parses CSV and bulk inserts invoices |
| `GET` | `/admin` | Admin (Basic Auth) | `handleAdminReviewQueue(env)` | Server-rendered HTML queue of pending AI drafts |
| `POST` | `/api/chase/:id/approve` | Admin (Basic Auth) | `handleChaseApprove(...)` | Sends chase email via `env.SEND`, updates draft |
| `POST` | `/api/chase/:id/skip` | Admin (Basic Auth) | `handleChaseSkip(...)` | Sets draft status to `'skipped'` |
| `POST` | `/api/billing/webhook` | Stripe HMAC Signature | `handleBillingWebhook(...)` | Idempotent Stripe webhook to sync client status |
| `GET` | `/portal` | Public / Cookie | `handlePortalLoginPage(...)` | Renders client login form |
| `POST` | `/portal/login` | Public | `handlePortalLoginRequest(...)` | Generates 15-min HMAC token, sends magic link |
| `GET` | `/portal/verify` | Public (Token param) | `handlePortalVerify(...)` | Verifies token, issues 7-day HttpOnly cookie |
| `POST` | `/portal/logout` | Client Session | Inline Cookie Clear | Clears `portal_session` cookie |
| `GET` | `/portal/dashboard` | Client Session | `handlePortalDashboard(...)` | Client dashboard (scoped by `session.cid`) |
| `POST` | `/portal/billing` | Client Session | `handlePortalBilling(...)` | Redirects client to Stripe Billing Portal |

### Cron Handlers (`backend/src/index.ts:233-240`)
- **`0 6 * * *` (`runOverdueDetection`)**:
  - Queries `invoices` where `status = 'overdue' AND due_date < date('now')`.
  - Determines escalation step (1 to 4) via `nextStepDue(daysOverdue, history)`.
  - Computes statutory interest and compensation.
  - Calls Gemini 2.5 Flash via REST `fetch()` to draft chase email.
  - Inserts draft into `chase_log` with `status = 'draft'`.
  - Sends summary notification email to operator via `env.NOTIFY`.
- **`0 8 * * FRI` (`runFridayReport`)**:
  - Queries active clients and aggregates invoices (paid this week, promised, still escalating).
  - Dispatches weekly summary email to `client.contact_email` via `env.SEND`.

---

## 5. In-Depth Gap Analysis: R1 (Multi-Tenant Data Architecture & Accounting Synchronization)

### 5.1 Multi-Tenant Data Isolation
- **Status:** **Partial**
- **Existing Strengths:**
  - Relational tables strictly define `client_id REFERENCES clients(id)`.
  - Uniqueness constraint `UNIQUE (client_id, invoice_number)` prevents cross-tenant invoice pollution.
  - Client portal route `/portal/dashboard` strictly extracts `clientId` from the cryptographically verified session token (`session.cid`) and binds it to all queries (`WHERE client_id = ?1`).
- **Gaps & Risks:**
  - **No Centralized Tenant Repository:** Data queries in `index.ts` are hand-crafted SQL strings. There is no scoped repository or query abstraction layer ensuring `client_id` cannot be omitted.
  - **Admin Actions Lack Multi-Tenant Auditing:** Admin routes `/api/chase/:id/approve` and `/api/chase/:id/skip` operate directly on `chase_log.id` without validating tenant boundaries or recording client context in the audit log.
  - **`accounting_webhook_events` Table Lacks Tenant Identifier:** Migration `0006` defines `accounting_webhook_events (id, provider, event_type, payload, processed_at)`. There is no `tenant_id` or `client_id` column, preventing tenant-indexed lookup and audit partitioning.

### 5.2 OAuth 2.0 Connection Lifecycle
- **Status:** **Scaffolding / Missing**
- **Existing Assets:**
  - `backend/db/migrations/0006_accounting_connections_and_external_sync.sql` defines the `accounting_connections` table.
  - `backend/src/lib/integrations/accounting-types.ts` defines `AccountingConnection` interface.
- **Critical Missing Components:**
  1. **No OAuth Routes Mounted in Worker:**
     - Missing `GET /api/oauth/xero/authorize` (or `/connect`)
     - Missing `GET /api/oauth/xero/callback`
     - Missing `GET /api/oauth/quickbooks/authorize` (or `/connect`)
     - Missing `GET /api/oauth/quickbooks/callback`
     - Missing `POST /api/oauth/:provider/disconnect`
     - Missing `GET /api/oauth/status`
  2. **No OAuth Flow Logic in Code:**
     - `backend/src/lib/integrations/oauth-manager.ts` only contains `encryptToken` and `decryptToken`.
     - Lacks authorization URL builder with state parameter (anti-CSRF).
     - Lacks code-to-token exchange logic (`fetch` to Xero token endpoint `https://identity.xero.com/connect/token` and QuickBooks token endpoint `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`).
     - Lacks token refresh mechanism: Xero access tokens expire in 30 minutes; QuickBooks in 60 minutes.
     - Lacks tenant resolution: Xero requires calling `https://api.xero.com/connections` to obtain the `tenantId`; QuickBooks provides `realmId` as a query parameter during callback.
  3. **Missing Environment Bindings:**
     - `wrangler.jsonc` does not define `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, or `TOKEN_ENCRYPTION_SECRET`.

### 5.3 AES-GCM 256-bit Token Encryption at Rest
- **Status:** **Implemented in Library, Unintegrated in Storage Flow**
- **Existing Assets:**
  - File: `backend/src/lib/integrations/oauth-manager.ts`
  - Implementation:
    - Derives 256-bit AES-GCM key from secret using `crypto.subtle.digest('SHA-256', encoder.encode(secretKey))`.
    - Generates 12-byte IV using `crypto.getRandomValues(new Uint8Array(12))`.
    - Encrypts payload with `AES-GCM` tag.
    - Packs `IV (12 bytes) + Ciphertext` into a single Uint8Array, base64 encoded.
    - Decryption extracts the first 12 bytes as IV, decrypts remaining bytes, and decodes UTF-8 string.
  - Test Suite: `tests/oauth.test.ts` successfully verifies encryption, decryption, and cipher asymmetry.
- **Gaps:**
  - Never invoked by any active route or service in `backend/src/index.ts` because OAuth token storage has not been hooked up.
  - Secret key management: `TOKEN_ENCRYPTION_SECRET` must be formalized as a required Cloudflare Worker secret.

### 5.4 Cryptographic Webhook Handlers (HMAC Verification)
- **Status:** **Implemented in Library, Unrouted in Worker**
- **Existing Assets:**
  - File: `backend/src/lib/integrations/webhooks.ts`
  - Implementation:
    - `verifyQuickBooksWebhook(payload, signatureHeader, verifierToken)`: Calculates HMAC-SHA256 signature, converts to base64, compares using constant-time `timingSafeEqual`.
    - `verifyXeroWebhook(payload, signatureHeader, webhookKey)`: Calculates HMAC-SHA256 signature, converts to base64, compares using constant-time `timingSafeEqual`.
    - Test Suite: `tests/webhooks.test.ts` tests positive matching, signature tampering rejection, and wrong key rejection.
- **Critical Missing Components:**
  1. **No Webhook Routes in `backend/src/index.ts`:**
     - `POST /api/webhooks/xero` is NOT in the route table.
     - `POST /api/webhooks/quickbooks` is NOT in the route table.
  2. **Missing Xero ITR (Intent to Receive) Handshake:**
     - When configuring Xero webhooks, Xero sends a handshake request with an invalid signature to test that the server returns HTTP 401, followed by a valid signature to test HTTP 200. The route must handle this without failing.
  3. **No Idempotent Webhook Processing:**
     - Webhook updates are not recorded into `accounting_webhook_events`.
     - Payloads are not parsed to trigger invoice state updates.

### 5.5 Idempotent Ingestion & Invoice Status Reconciliation
- **Status:** **Missing / Stub**
- **Existing Assets:**
  - File: `backend/src/lib/integrations/sync-service.ts`
    ```typescript
    export class SyncService {
      async syncInvoices(clientId: number) {
        return { success: true };
      }
    }
    ```
- **Critical Missing Components:**
  1. **Webhook-Driven Event Processing:**
     - When Xero sends an `INVOICE / UPDATE` event or QuickBooks sends an `Invoice / Update` entity, the system must:
       - Check `accounting_webhook_events` to deduplicate against replay attacks.
       - Fetch the updated invoice from the provider API.
       - Update the invoice in D1 (`invoices.status = 'paid'`, `invoices.paid_date = date('now')`, `invoices.last_synced_at = datetime('now')`).
  2. **Daily Polling Job:**
     - R1 requires "daily polling jobs to continuously ingest and reconcile unpaid debtor invoices".
     - Currently, the cron trigger at `06:00 UTC` only runs `runOverdueDetection` which queries existing D1 invoices.
     - There is no background cron job to iterate through active `accounting_connections`, refresh tokens if expired, poll Xero/QuickBooks for unpaid invoices, and reconcile discrepancies (e.g. marking externally paid invoices as `paid` in D1 so automated chasing ceases immediately).
  3. **Full Provider Sync Implementation:**
     - Zero-dependency REST sync methods using plain `fetch()`:
       - Xero: `GET https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED,PAID`
       - QuickBooks: `GET https://quickbooks.api.intuit.com/v3/company/{realmId}/query?query=select * from Invoice where Balance > 0`
       - Idempotent upsert logic into D1 `invoices` matching on `(client_id, invoice_number)`.

---

## 6. In-Depth Gap Analysis: R4 (Edge Infrastructure & Deliverability Controls)

### 6.1 Cloudflare Edge Runtime Compliance
- **Status:** **Fully Compliant**
- **Assessment:**
  - Code runs directly on Cloudflare Workers edge runtime with `nodejs_compat`.
  - Zero external runtime package dependencies (`package.json`).
  - Native Web Standards: `fetch`, `Response`, `Request`, `Headers`, `crypto.subtle`, `TextEncoder`, `TextDecoder`, `btoa`, `atob`.
  - Cold starts and bundle size are minimal (dry-run bundle size: ~42.8 KiB uncompressed).
  - **Implementation Guideline:** Any implementation of OAuth, Xero/QBO APIs, or synchronization MUST NOT import third-party SDKs (such as `xero-node`, `intuit-oauth`, `axios`, or `jsonwebtoken`). They must follow the pattern established in `stripe.ts` and `gemini.ts`.

### 6.2 Cloudflare D1 SQLite Compliance
- **Status:** **Fully Compliant**
- **Assessment:**
  - Database binding `env.DB` points to `invoice-rescue-db`.
  - 6 schema migrations are properly tracked in `backend/db/migrations/` and verified with `wrangler d1 migrations apply invoice-rescue-db --local`.
  - D1 SQLite features leveraged:
    - Foreign key references (`REFERENCES clients(id)`).
    - Composite uniqueness constraints (`UNIQUE (client_id, invoice_number)`).
    - CHECK constraints for enum validity.
    - Fast indexed queries on `(client_id)` and `(status, due_date)`.

### 6.3 Split-Trust Email Routing & Deliverability
- **Status:** **Partially Compliant / Configured**
- **Assessment:**
  - Binding separation in `wrangler.jsonc` (`NOTIFY` vs `SEND`) enforces the split-trust model.
  - Locked sender model (`hello@invoicerescue.co.uk`) and fixed sign-off preserve sender reputation.
- **Identified Gaps & Deliverability Risks:**
  1. **Debtor Unsubscribe Mechanism:** Under UK PECR and GDPR rules, commercial emails require a functional opt-out/unsubscribe channel. Currently, emails sent by `handleChaseApprove` do not include an unsubscribe link or `List-Unsubscribe` header.
  2. **Bounce Feedback Ingestion:** D1 `chase_log.outcome` includes `'bounced'` in its CHECK constraint, but there is no mechanism to catch bounce events from Cloudflare Email Routing.
  3. **Public Endpoint Rate-Limiting:** `/portal/login` accepts email addresses without IP rate-limiting, which could be abused to trigger email dispatch floods via `env.SEND`.

---

## 7. Requirement Status Matrix

| Requirement Area | Sub-Component | Current Code File(s) | Status | Severity / Priority |
| :--- | :--- | :--- | :--- | :--- |
| **R1: Multi-Tenant Architecture** | Data Model & Tenant Scoping | `backend/db/migrations/0003_add_check_constraints.sql` | **Implemented** | Complete |
| **R1: Multi-Tenant Architecture** | Client Portal Scoped Queries | `backend/src/index.ts:605-636` | **Implemented** | Complete |
| **R1: Multi-Tenant Architecture** | Centralized Tenant Isolation Query Layer | Missing | **Missing** | High (Architectural) |
| **R1: Accounting Synchronization** | OAuth AES-GCM 256-bit Encryption | `backend/src/lib/integrations/oauth-manager.ts` | **Implemented** (Unintegrated) | Medium |
| **R1: Accounting Synchronization** | OAuth 2.0 Authorization & Callback Routes | Missing in `backend/src/index.ts` | **Missing** | High |
| **R1: Accounting Synchronization** | OAuth Token Exchange & Auto-Refresh | Missing in `oauth-manager.ts` | **Missing** | High |
| **R1: Accounting Synchronization** | Webhook Cryptographic HMAC Verification | `backend/src/lib/integrations/webhooks.ts` | **Implemented** (Unrouted) | High |
| **R1: Accounting Synchronization** | Webhook Router Endpoints (Xero, QBO) | Missing in `backend/src/index.ts` | **Missing** | High |
| **R1: Accounting Synchronization** | Webhook Event Deduplication & Ingestion | `backend/db/migrations/0006_...` | **Scaffolded** (No logic) | High |
| **R1: Accounting Synchronization** | Idempotent Invoice Status Reconciliation | `backend/src/lib/integrations/sync-service.ts` | **Stub** | High |
| **R1: Accounting Synchronization** | Daily Polling Sync Job | Missing in `scheduled()` cron | **Missing** | High |
| **R4: Edge Infrastructure** | Zero External Runtime Dependencies | `package.json`, `backend/src/lib/stripe.ts`, `gemini.ts` | **Implemented** (100%) | Complete |
| **R4: Edge Infrastructure** | Cloudflare D1 SQLite Database | `backend/db/migrations/` | **Implemented** (100%) | Complete |
| **R4: Edge Infrastructure** | Split-Trust Email Routing (`NOTIFY` / `SEND`) | `wrangler.jsonc`, `backend/src/index.ts` | **Implemented** | Complete |
| **R4: Deliverability Controls** | Locked Sender Identity & Anti-Bot Honeypot | `backend/src/index.ts:91, 247` | **Implemented** | Complete |
| **R4: Deliverability Controls** | Endpoint Rate Limiting (`/portal/login`) | Missing | **Partial** | Medium |
| **R4: Deliverability Controls** | Automated Bounce Handling | Missing | **Gap** | Low/Medium |

---

## 8. Concrete Architecture Blueprint for Backend Implementation

To achieve full compliance with R1 and R4 without violating the zero-dependency edge runtime constraint, the implementation should follow this architectural plan:

### 1. Centralized Tenant Isolation Repository (`backend/src/lib/tenant-db.ts`)
Create a scoped database helper:
```typescript
export class TenantDatabase {
  constructor(private db: D1Database, public readonly clientId: number) {}
  
  async getInvoices() {
    return this.db.prepare("SELECT * FROM invoices WHERE client_id = ?1").bind(this.clientId).all();
  }
  
  async upsertInvoice(inv: ExternalInvoice) {
    return this.db.prepare(
      `INSERT INTO invoices (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, due_date, status, external_id, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
       ON CONFLICT(client_id, invoice_number) DO UPDATE SET
         amount_pence = excluded.amount_pence,
         status = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE excluded.status END,
         last_synced_at = datetime('now')`
    ).bind(this.clientId, inv.debtor_name, inv.debtor_email, inv.invoice_number, inv.amount_pence, inv.currency, inv.due_date, inv.status, inv.external_id).run();
  }
}
```

### 2. OAuth 2.0 Integration Engine (`backend/src/lib/integrations/oauth-service.ts`)
Implement zero-dependency plain `fetch()` OAuth managers:
- **Xero:**
  - Auth URL: `https://login.xero.com/identity/connect/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope=accounting.transactions.read accounting.contacts.read offline_access`, `state`.
  - Token Exchange: `POST https://identity.xero.com/connect/token` (Basic Auth with `client_id:client_secret`).
  - Tenant ID: `GET https://api.xero.com/connections` to obtain `tenantId`.
  - Token Refresh: `grant_type=refresh_token`.
- **QuickBooks:**
  - Auth URL: `https://appcenter.intuit.com/connect/oauth2` with `response_type=code`, `client_id`, `redirect_uri`, `scope=com.intuit.quickbooks.accounting`, `state`.
  - Token Exchange: `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`.
- Encrypt tokens via `encryptToken(token, env.TOKEN_ENCRYPTION_SECRET)` and store in `accounting_connections`.

### 3. Webhook Router Mounting (`backend/src/index.ts`)
Add routes in `fetch()`:
```typescript
if (request.method === "POST" && path === "/api/webhooks/xero") {
  return await handleXeroWebhook(request, env);
}
if (request.method === "POST" && path === "/api/webhooks/quickbooks") {
  return await handleQuickBooksWebhook(request, env);
}
```
- For Xero: Handle ITR (Intent to Receive) verification: verify `x-xero-signature` header via `verifyXeroWebhook()`. If valid, return 200; if invalid, return 401.
- For QuickBooks: Verify `intuit-signature` header via `verifyQuickBooksWebhook()`.
- Record event in `accounting_webhook_events` with deduplication check (`SELECT id FROM accounting_webhook_events WHERE id = ?1`).

### 4. Idempotent Ingestion & Scheduled Sync (`backend/src/lib/integrations/sync-service.ts`)
- Replace stub with functional `SyncService`:
  - Fetch unpaid invoices from Xero (`GET /api.xro/2.0/Invoices?Statuses=AUTHORISED`) and QuickBooks.
  - Upsert invoices in D1.
  - If an invoice is marked paid in the provider, update D1 `invoices.status = 'paid'`, `invoices.paid_date = date('now')`.
- Hook into `scheduled()` cron handler:
  - Add sync pass to the `0 6 * * *` cron job before running `runOverdueDetection(env)` so the latest payments are reconciled before drafting chases.

### 5. Environment & Secret Declarations (`wrangler.jsonc`)
Document required secrets in `wrangler.jsonc` and `worker-configuration.d.ts`:
- `TOKEN_ENCRYPTION_SECRET`
- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_WEBHOOK_KEY`
- `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_VERIFIER_TOKEN`

---

## 9. Conclusion

The existing codebase is clean, well-tested (31 passing tests), strictly typed, and completely compliant with Cloudflare Workers zero-dependency edge architecture (R4). The core challenge is that the accounting synchronization and OAuth features (R1) exist only as standalone cryptographic utility functions and database migration tables. Integrating these utilities into complete, route-mounted, scheduled, and idempotent workflows will satisfy all remaining requirements.
