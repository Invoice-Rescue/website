# Handoff Report: M1 Webhooks & Accounting Synchronization

**Author:** M1 Webhooks & Sync Explorer  
**Working Directory:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_webhooks_sync`  
**Date:** 2026-09-16  
**Milestone:** M1 (R1) - Webhooks & Sync  

---

## 1. Observation

1. **Webhook Cryptographic Verifiers Exist**:
   - `backend/src/lib/integrations/webhooks.ts:1-41` implements `verifyQuickBooksWebhook` and `verifyXeroWebhook` using the Web Crypto API (`crypto.subtle.importKey`, `crypto.subtle.sign` HMAC-SHA256, Base64 conversion, and constant-time `timingSafeEqual`).
   - `tests/webhooks.test.ts:5-47` validates signature verification for both QuickBooks and Xero.

2. **Webhook Endpoints Are Not Mounted in Worker Router**:
   - `backend/src/index.ts:148-231` defines the Worker `fetch()` route dispatcher. Routes exist for `/api/health`, `/api/statutory-rate`, `/api/billing/webhook`, `/portal/*`, `/api/lead`, `/api/clients`, `/admin`, and `/api/chase/*`.
   - Neither `POST /api/webhooks/xero` nor `POST /api/webhooks/quickbooks` is mounted in `index.ts`.

3. **SyncService is a Non-Functional Stub**:
   - `backend/src/lib/integrations/sync-service.ts:1-5`:
     ```typescript
     export class SyncService {
       async syncInvoices(clientId: number) {
         return { success: true };
       }
     }
     ```
   - No invoice ingestion, no token refresh, no D1 reconciliation, and no side-effect cancellation logic exists.

4. **Accounting Tables Already Migrated in D1**:
   - `backend/db/migrations/0006_accounting_connections_and_external_sync.sql:1-23` creates:
     - `accounting_connections`: `client_id`, `provider` ('xero' | 'quickbooks'), `tenant_id`, `access_token_encrypted`, `refresh_token_encrypted`, `expires_at`, `last_synced_at`, `status`, with `UNIQUE(client_id, provider)`.
     - `accounting_webhook_events`: `id TEXT PRIMARY KEY`, `provider`, `event_type`, `payload`, `processed_at`.

5. **Token Encryption Utilities Exist**:
   - `backend/src/lib/integrations/oauth-manager.ts:1-57` implements `encryptToken` and `decryptToken` using AES-GCM (256-bit) with random 12-byte IV.
   - `tests/oauth.test.ts` confirms successful round-trip encryption/decryption.

6. **Scheduled Cron Runs Without Ingestion Sync**:
   - `backend/src/index.ts:233-240`:
     ```typescript
     async scheduled(event: ScheduledController, env: Env): Promise<void> {
       if (event.cron === "0 6 * * *") {
         await runOverdueDetection(env);
       } else if (event.cron === "0 8 * * FRI") {
         await runFridayReport(env);
       }
     }
     ```
   - At `06:00 UTC`, `runOverdueDetection(env)` executes directly on D1 invoices without synchronizing provider payment status first, creating a risk that paid invoices are chased.

7. **Project Test and Build Baseline**:
   - Tool execution `npm test` outputs `ℹ pass 31 ℹ fail 0` in 939ms.
   - Tool execution `npx tsc --noEmit` completed with 0 errors.

---

## 2. Logic Chain

1. **Webhook Routing Gap**:
   - Observation 1 proves cryptographic verifiers are implemented and tested, but Observation 2 proves they are unreachable via HTTP.
   - Therefore, implementers must mount `POST /api/webhooks/xero` and `POST /api/webhooks/quickbooks` in `backend/src/index.ts`.

2. **Xero Intent to Receive (ITR) Compliance**:
   - Xero webhook verification documentation dictates that Xero pings new endpoints with an invalid signature, requiring an HTTP 401 response; it then pings with a valid signature, requiring HTTP 200.
   - Handlers returning 400 or 500 will fail Xero's ITR verification. Hence, `handleXeroWebhook` must explicitly return `new Response("Unauthorized", { status: 401 })` when signature verification fails.

3. **Event Deduplication Logic**:
   - Observation 4 shows `accounting_webhook_events` has `id TEXT PRIMARY KEY`.
   - Providers send batch events that lack a root event ID (Xero supplies `events[]`, QuickBooks supplies `eventNotifications[].entities[]`).
   - Generating a deterministic event ID (`xero_${tenantId}_${resourceId}_${eventType}_${eventDateUtc}` and `qb_${realmId}_${entityName}_${id}_${operation}_${lastUpdated}`) allows atomic deduplication against `accounting_webhook_events`.

4. **SyncService & Chasing Suppression Invariant**:
   - Observation 3 shows `SyncService` is currently a stub.
   - When an invoice is settled in Xero or QuickBooks, D1 `invoices.status` must update to `'paid'` AND any pending drafts in `chase_log` must update to `'skipped'`.
   - If this side-effect cancellation is omitted, an overdue chase draft queued prior to payment will be approved and sent to a client who already paid.

5. **Cron Execution Order**:
   - Observation 6 shows `runOverdueDetection` runs at 06:00 UTC with no prior sync.
   - Ingesting active provider connections in `pollActiveAccountingProviders(env)` immediately before `runOverdueDetection(env)` eliminates race conditions where overnight payments are ignored.

---

## 3. Caveats

1. **OAuth Connection Prerequisite**:
   - Webhook processing maps `tenantId` (Xero) or `realmId` (QuickBooks) to `client_id` via `accounting_connections`. If no active connection exists with that tenant ID, webhook updates cannot be applied to invoices.
2. **Provider API Rate Limits**:
   - In production with high client volumes, batch queries (`GET /Invoices?Statuses=AUTHORISED,PAID` and `SELECT * FROM Invoice MAXRESULTS 1000`) must respect Xero's 60 requests/minute and QuickBooks' 500 requests/minute limits.
3. **Environment Secrets Availability**:
   - Cryptographic verification and token decryption depend on secrets (`XERO_WEBHOOK_KEY`, `QUICKBOOKS_VERIFIER_TOKEN`, `TOKEN_ENCRYPTION_SECRET`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`). In local test environments, mock keys must be supplied.

---

## 4. Conclusion

Milestone M1 (R1) webhook and sync functionality can be cleanly implemented without external dependencies by:
1. Mounting `POST /api/webhooks/xero` (with strict 401 ITR response) and `POST /api/webhooks/quickbooks` in `backend/src/index.ts`.
2. Synthesizing deterministic event IDs for deduplication in `accounting_webhook_events`.
3. Upgrading `SyncService` to auto-refresh OAuth tokens, fetch invoices via native `fetch()`, upsert into D1 `invoices` under `UNIQUE (client_id, invoice_number)`, and cancel pending `chase_log` drafts when invoices settle.
4. Prepending `pollActiveAccountingProviders(env)` to the daily 06:00 UTC cron trigger before `runOverdueDetection(env)`.

The detailed specifications, schemas, and code implementations are documented in `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_webhooks_sync\report.md`.

---

## 5. Verification Method

1. **Type Check**:
   ```powershell
   npx tsc --noEmit
   ```
   *Expected result:* 0 errors.

2. **Automated Unit Tests**:
   ```powershell
   npm test
   ```
   *Expected result:* All unit tests pass (including existing `tests/webhooks.test.ts` and `tests/oauth.test.ts`).

3. **Dry-Run Cloudflare Worker Build**:
   ```powershell
   npm run build
   ```
   *Expected result:* `wrangler deploy --dry-run` successfully bundles under 50 KiB with zero external runtime dependencies.

4. **Local D1 Migration Verification**:
   ```powershell
   npx wrangler d1 migrations apply invoice-rescue-db --local
   ```
   *Expected result:* All 6 migrations applied cleanly with `accounting_connections` and `accounting_webhook_events` present.
