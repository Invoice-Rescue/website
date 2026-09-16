# Milestone M1 Handoff Report: Multi-Tenant Data Architecture & Accounting Synchronization (R1)

## 1. Observation

### Implementation & Verification Evidence
- **Tenant Repository (`backend/src/lib/tenant-repo.ts`)**:
  - Implemented functional tenant query APIs: `getTenantInvoices`, `getTenantInvoiceByNumber`, `getTenantInvoiceById`, `upsertTenantInvoice`, `recordAccountingWebhook`, `getAccountingConnection`, `upsertAccountingConnection`, `resolveClientByAccountingTenant`, `getTenantDrafts`, `approveTenantDraft`, `skipTenantDraft`.
  - Implemented typed domain error hierarchy: `InvalidTenantError`, `TenantBoundaryViolationError`, `InvalidInvoiceDataError`, `InvalidWebhookEventError`, `InvalidInputError`.
  - Implemented `TenantRepository` class permanently binding `clientId` to prevent accidental cross-tenant queries.
  - Implemented atomic upsert query preserving paid invoices:
    ```sql
    INSERT INTO invoices (id, client_id, invoice_number, debtor_name, debtor_email, debtor_phone, amount, due_date, status, paid_date, last_synced_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
    ON CONFLICT(client_id, invoice_number) DO UPDATE SET
      debtor_name = excluded.debtor_name,
      debtor_email = excluded.debtor_email,
      debtor_phone = excluded.debtor_phone,
      amount = excluded.amount,
      due_date = excluded.due_date,
      status = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE excluded.status END,
      paid_date = CASE WHEN invoices.status = 'paid' THEN invoices.paid_date ELSE excluded.paid_date END,
      last_synced_at = datetime('now')
    ```
- **Unified DB Facade (`backend/src/lib/db.ts`)**:
  - Re-exports tenant repository functions, `TenantRepository` class, and typed error classes for seamless backwards compatibility and centralized database operations.
- **Zero-Dependency OAuth Manager (`backend/src/lib/integrations/oauth-manager.ts`)**:
  - HMAC-SHA256 state generation and cryptographic verification (`generateOAuthState`, `verifyOAuthState`) with a 10-minute expiration window and replay protection.
  - Authorization URL builder with provider-specific scopes (`buildAuthorizationUrl` for Xero and QuickBooks).
  - Code exchange (`exchangeCodeForTokens`), token refresh (`refreshProviderTokens`), and revocation handling (`revokeProviderToken`).
  - AES-GCM (256-bit) token encryption and decryption (`encryptToken`, `decryptToken`) using Web Crypto API (`crypto.subtle`).
- **Accounting Sync Service (`backend/src/lib/integrations/sync-service.ts`)**:
  - Implemented `SyncService` class supporting `fullSync(client)`, `syncInvoice(client, invoiceNumber)`, and `reconcileInvoice(client, rawInvoice)`.
  - Automatic token expiration detection and inline refresh via `refreshProviderTokens`.
  - Xero API integration (`GET /api.xro/2.0/Invoices`) with status mapping (`PAID` -> `'paid'`, `AUTHORISED` -> `'overdue'`, `VOIDED` -> `'cancelled'`).
  - QuickBooks API integration (`GET /v3/company/:realmId/query`) with balance checking (`Balance === 0` -> `'paid'`).
  - Draft chase suppression upon invoice payment or dispute:
    ```sql
    UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now')
    WHERE invoice_id = ?1 AND status = 'draft'
    ```
- **Worker Routing & Cron Execution (`backend/src/index.ts`)**:
  - Mounted OAuth routes: `GET /api/oauth/:provider/connect`, `GET /api/oauth/:provider/callback`, `POST /api/oauth/:provider/refresh`, `POST /api/oauth/:provider/disconnect`, `GET /api/oauth/:provider/status`.
  - Authenticated via session cookie (`portal_session`) or Bearer token header (`Authorization`).
  - Mounted webhook routes: `POST /api/webhooks/xero`, `POST /api/webhooks/quickbooks`.
  - Implemented Xero Intent to Receive (ITR) protocol: returns HTTP 401 on invalid signature probe and HTTP 200 on valid signature.
  - Webhook event deduplication via `accounting_webhook_events`.
  - Cron trigger in `scheduled()`: invokes `pollActiveAccountingProviders(env)` prior to `runOverdueDetection(env)` at 06:00 UTC.
  - Upgraded `handleInvoiceImport` to use `upsertTenantInvoice`.
- **Automated Verification Test Suites**:
  - `tests/tenant-repo.test.ts`: 9 tests verifying tenant isolation, cross-tenant duplicate invoice numbers, atomic upsert status preservation, webhook idempotency, connection lifecycle, and class-based scoping.
  - `tests/oauth-endpoints.test.ts`: 10 tests verifying HMAC state signing/tampering, connect redirects, code exchange, realmId handling, refresh lifecycle, invalid_grant revocation, status masking, and disconnect.
  - `tests/sync-service.test.ts`: 7 tests verifying reconciliation, paid draft cancellation, disputed draft cancellation, Xero ITR probe 401/200, QuickBooks webhook deduplication, full provider sync, and cron scheduled accounting sync.

### Verbatim Command Execution Outputs
- **Unit & Integration Test Suite (`npm test`)**:
  ```
  ℹ tests 306
  ℹ suites 57
  ℹ pass 306
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 3115.9447
  ```
- **TypeScript Compilation Check (`npx tsc --noEmit`)**:
  - Exited code 0 with 0 diagnostics/errors.
- **Build / Bundle Dry Run (`npm run build`)**:
  ```
  ⛅️ wrangler 4.131.0
  ✨ Read 20 files from the assets directory D:\Dev\Workspaces\Active\invoice-rescue\frontend
  Total Upload: 87.60 KiB / gzip: 19.79 KiB
  --dry-run: exiting now.
  ```
- **D1 Migrations Verification (`npx wrangler d1 migrations apply invoice-rescue-db --local`)**:
  ```
  ⛅️ wrangler 4.131.0
  Resource location: local
  ✅ No migrations to apply!
  ```

---

## 2. Logic Chain

1. **Multi-Tenant Isolation via Explicit Query Scoping**:
   - Every invoice query executed against D1 explicitly filters by `client_id = ?1`.
   - The database constraint `UNIQUE(client_id, invoice_number)` allows multiple tenants to use identical invoice numbers (e.g. `INV-001`) without collisions.
   - Any query attempting to access or modify an invoice not belonging to `client_id` returns `null` or throws `TenantBoundaryViolationError`.
2. **Settled Invoice Protection (Non-Downgrade Invariant)**:
   - When an invoice status is `'paid'`, an external accounting sync or CSV import must never overwrite it back to `'overdue'`.
   - The atomic upsert SQL uses:
     `status = CASE WHEN invoices.status = 'paid' THEN 'paid' ELSE excluded.status END`.
   - This ensures database-level immutability of paid invoices regardless of upstream data race conditions.
3. **Automated Chase Draft Halting**:
   - If an invoice is paid or marked disputed, active chases must cease immediately to avoid embarrassing debtor communications.
   - `reconcileInvoice` in `SyncService` updates pending drafts in `chase_log`:
     `UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE invoice_id = ?1 AND status = 'draft'`.
4. **Zero External Runtime Dependencies**:
   - By utilizing standard Web Crypto APIs (`crypto.subtle.importKey`, `crypto.subtle.encrypt`, `crypto.subtle.decrypt`, `crypto.subtle.sign`, `crypto.subtle.verify`) and native `fetch()`, zero external NPM runtime dependencies were introduced.
   - Preserves minimal edge bundle size (Worker script < 100 KiB) and eliminates supply-chain vulnerabilities.
5. **Cryptographic Webhook Validation & Xero ITR**:
   - Xero sends an ITR probe during webhook configuration with an intentionally invalid signature. Returning HTTP 200 causes Xero to reject the webhook setup.
   - The webhook handler performs `crypto.subtle.verify` before processing; on signature mismatch, it immediately halts and returns HTTP 401. On valid signature, it processes events and returns HTTP 200.

---

## 3. Caveats

- **SQLite Parameter Syntax in Node vs D1**:
  - When running unit tests with `node:sqlite`, string literals must be single-quoted (`'xero'`). Double quotes (`"xero"`) are treated as column identifiers and throw `no such column`. In code, parameterized queries (`?1`, `?2`) are consistently applied to guarantee portability between Cloudflare D1 and `node:sqlite`.
- **QuickBooks Invoicing Pagination**:
  - In the current implementation, QuickBooks queries pull up to 1,000 invoices per call (`MAXRESULTS 1000`). If a client has more than 1,000 active unpaid invoices in QuickBooks, multi-page cursor traversal can be scheduled in subsequent performance iterations.
- **Cron Synchronization Concurrency**:
  - In `scheduled()`, `pollActiveAccountingProviders` executes sequentially across all active connections before running overdue detection. For very large client bases (>100 clients), processing via Cloudflare Queues or batching will provide horizontal scale.

---

## 4. Conclusion

Milestone M1 (Multi-Tenant Data Architecture & Accounting Synchronization - R1) is fully complete:
- Tenant isolation is robustly enforced at both database and application layers.
- Zero-dependency OAuth 2.0 connection lifecycle is fully operational with AES-GCM token encryption and HMAC-SHA256 signed state tokens.
- Cryptographic webhooks for Xero (including ITR compliance) and QuickBooks are verified and deduplicated.
- Ingestion and synchronization pipelines accurately reconcile invoice statuses and halt pending chase drafts upon payment or dispute.
- Daily cron triggers accounting synchronization prior to overdue invoice escalation.
- All 306 tests across 57 suites pass 100%, TypeScript passes with 0 diagnostics, and dry-run build is clean.

---

## 5. Verification Method

### Independent Reproduction Commands
To independently verify this milestone from the project root (`d:\Dev\Workspaces\Active\invoice-rescue`):

1. **Run Full Test Suite**:
   ```bash
   npm test
   ```
   *Expected result*: 306 passing tests across 57 suites, 0 failures.
2. **Run TypeScript Check**:
   ```bash
   npx tsc --noEmit
   ```
   *Expected result*: Exit code 0, 0 errors.
3. **Run Production Bundle Dry Run**:
   ```bash
   npm run build
   ```
   *Expected result*: Wrangler dry-run bundle completes successfully with exit code 0.
4. **Run Local Database Migrations**:
   ```bash
   npx wrangler d1 migrations apply invoice-rescue-db --local
   ```
   *Expected result*: Exit code 0, "No migrations to apply!".

### Files Modified & Created
- `backend/src/lib/tenant-repo.ts` (Tenant isolation repo & error classes)
- `backend/src/lib/db.ts` (Unified database facade)
- `backend/src/lib/integrations/oauth-manager.ts` (Zero-dep OAuth 2.0 lifecycle)
- `backend/src/lib/integrations/sync-service.ts` (Accounting synchronization & reconciliation)
- `backend/src/index.ts` (Route mounting, webhook handling, cron scheduling)
- `tests/tenant-repo.test.ts` (Tenant repo test suite)
- `tests/oauth-endpoints.test.ts` (OAuth endpoints test suite)
- `tests/sync-service.test.ts` (SyncService test suite)

### Invalidation Conditions
- Any cross-tenant read or write returning data from a different `client_id`.
- External sync or import reverting an invoice with `status = 'paid'` to `'overdue'`.
- Any compilation error during `npx tsc --noEmit`.
- Any failure in `npm test`.
