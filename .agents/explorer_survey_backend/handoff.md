# Handoff Report: Backend Architecture Survey (R1 & R4)

**Agent:** Backend Architecture Explorer  
**Working Directory:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_survey_backend`  
**Date:** 2026-09-16  
**Parent Agent:** `98533014-b436-4060-87b0-afd5a79cff5a`

---

## 1. Observation

1. **Edge Runtime & Zero Runtime Dependencies (R4):**
   - File: `package.json:38-49`: `dependencies` object is absent. Only `devDependencies` exist (`@cloudflare/workers-types`, `@types/node`, `markdownlint-cli2`, `tsx`, `typescript`, `wrangler`).
   - File: `wrangler.jsonc:7-12`: `compatibility_date: "2026-07-15"`, `compatibility_flags: ["nodejs_compat"]`, `main: "backend/src/index.ts"`.
   - Tool execution: `npm test` exited code `0` (31 tests passed across 6 suites).
   - Tool execution: `npx tsc --noEmit` exited code `0` (zero type errors).
   - Tool execution: `npm run build` (`wrangler deploy --dry-run`) exited code `0` (bundle size 42.84 KiB).

2. **D1 SQLite Database & Migrations (R1 & R4):**
   - File: `wrangler.jsonc:26-35`: D1 database bound to `DB`, database `invoice-rescue-db`, ID `b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`, `migrations_dir: "./backend/db/migrations"`.
   - Files: Migrations `0001_initial_schema.sql` through `0006_accounting_connections_and_external_sync.sql`.
   - Migration `0003_add_check_constraints.sql:73`: Enforces `UNIQUE (client_id, invoice_number)`.
   - Migration `0006_accounting_connections_and_external_sync.sql:1-22`: Defines `accounting_connections` (with `client_id`, `provider`, `tenant_id`, `access_token_encrypted`, `refresh_token_encrypted`) and `accounting_webhook_events`.
   - Tool execution: `npx wrangler d1 migrations apply invoice-rescue-db --local` output: `✅ No migrations to apply!`.

3. **Split-Trust Email Routing (R4):**
   - File: `wrangler.jsonc:37-50`: Defines two `send_email` bindings:
     - `NOTIFY`: `destination_address: "tiborcc2@gmail.com"` (operator alerts only)
     - `SEND`: Unrestricted destination
   - File: `backend/src/index.ts`:
     - Line 267: `env.NOTIFY.send` used for incoming audit leads.
     - Line 824: `env.NOTIFY.send` used for operator draft queue alerts.
     - Line 503: `env.SEND.send` used for approved debtor chase messages.
     - Line 574: `env.SEND.send` used for client magic login links.
     - Line 871: `env.SEND.send` used for Friday client cash reports.

4. **Multi-Tenant Accounting Synchronization & Cryptography (R1):**
   - File: `backend/src/lib/integrations/oauth-manager.ts:1-58`: Implements Web Crypto `encryptToken` and `decryptToken` using `AES-GCM` with 256-bit key from SHA-256 hash and 12-byte random IV. Tested in `tests/oauth.test.ts`.
   - File: `backend/src/lib/integrations/webhooks.ts:1-41`: Implements `verifyQuickBooksWebhook` and `verifyXeroWebhook` using `crypto.subtle` HMAC-SHA256 and constant-time `timingSafeEqual`. Tested in `tests/webhooks.test.ts`.
   - File: `backend/src/lib/integrations/sync-service.ts:1-6`: Stub implementation:
     ```typescript
     export class SyncService {
       async syncInvoices(clientId: number) {
         return { success: true };
       }
     }
     ```
   - File: `backend/src/index.ts:153-222`: Router contains NO routes for `/api/oauth/*`, `/api/webhooks/xero`, or `/api/webhooks/quickbooks`.
   - File: `backend/src/index.ts:233-240`: Cron scheduled handler runs `runOverdueDetection` and `runFridayReport`, but has no accounting invoice sync polling job.

---

## 2. Logic Chain

1. **Deduction on R4 (Edge Runtime & Dependencies):**
   - *Premise:* `package.json` contains no runtime dependencies, and all code uses Worker-native APIs (`fetch`, `crypto.subtle`, `Response`).
   - *Premise:* `wrangler deploy --dry-run` compiles and bundles cleanly without errors.
   - *Conclusion:* R4's edge runtime and zero external dependency constraints are 100% satisfied.

2. **Deduction on R4 (Split-Trust Email Routing):**
   - *Premise:* `NOTIFY` is locked in `wrangler.jsonc` to the operator's inbox, while `SEND` is unrestricted.
   - *Premise:* Code strictly routes internal notifications through `NOTIFY` and external client/debtor messages through `SEND`.
   - *Conclusion:* R4's split-trust routing requirement is fulfilled in architecture and code.

3. **Deduction on R1 (Multi-Tenancy):**
   - *Premise:* The database enforces foreign keys `client_id REFERENCES clients(id)` and `UNIQUE (client_id, invoice_number)`.
   - *Premise:* Client portal queries in `index.ts` filter strictly by authenticated `session.cid`.
   - *Premise:* However, admin routes act on global IDs, `accounting_webhook_events` lacks a `client_id` column, and there is no unified tenant-scoped query repository.
   - *Conclusion:* Multi-tenancy is partially implemented at the schema level but lacks an end-to-end tenant query isolation boundary across all ingestion endpoints.

4. **Deduction on R1 (OAuth & Accounting Sync):**
   - *Premise:* AES-GCM 256-bit token encryption and HMAC webhook verification functions exist in `lib/integrations/` and pass tests.
   - *Premise:* Neither `backend/src/index.ts` nor any cron triggers mount OAuth endpoints, webhook endpoints, or invoice polling jobs.
   - *Premise:* `SyncService` is a 6-line stub.
   - *Conclusion:* R1 accounting synchronization is currently in a scaffolded state. Full compliance requires building the OAuth lifecycle handlers, mounting HMAC webhook listeners, and implementing the idempotent sync service with daily cron polling.

---

## 3. Caveats

1. **OAuth Provider Sandboxes:** Xero and Intuit QuickBooks developer accounts and app credentials (`client_id`, `client_secret`) are not present in `.dev.vars` or environment variables; testing OAuth callbacks against live providers will require mock fixtures or sandbox credentials.
2. **Xero Webhook Intent to Receive (ITR):** When configuring Xero webhooks in production, Xero performs an ITR verification check (sending intentionally invalid signatures to expect HTTP 401, then valid signatures to expect HTTP 200). The webhook route handler must be tested for this dual behavior.
3. **PECR & Debtor Unsubscribe:** While B2B corporate entities (Ltd, PLC) can be contacted under Legitimate Interest, Sole Traders and Partnerships are treated as consumers under UK PECR requiring opt-in or an easy opt-out mechanism. Outbound debtor emails currently lack an automated unsubscribe header or footer link.

---

## 4. Conclusion

The backend codebase provides a robust, zero-dependency Cloudflare Workers edge architecture backed by Cloudflare D1 and split-trust email routing, satisfying **R4**.

For **R1**, the cryptographic primitives (AES-GCM 256-bit encryption and HMAC verification) and database tables (`accounting_connections`, `accounting_webhook_events`) are already present and verified by unit tests. The critical next steps for the implementation phase are:
1. Implement zero-dependency OAuth 2.0 connection lifecycle endpoints for Xero and QuickBooks.
2. Mount the cryptographic HMAC webhook endpoints (`/api/webhooks/xero`, `/api/webhooks/quickbooks`) in `backend/src/index.ts`.
3. Implement the `SyncService` to fetch, deduplicate, and idempotently reconcile unpaid debtor invoices in D1.
4. Add a daily accounting synchronization polling pass to the scheduled cron trigger.
5. Encapsulate database access in a tenant-isolated repository helper.

---

## 5. Verification Method

To independently reproduce and verify all findings:
1. **Type Check:** Run `npx tsc --noEmit` from the project root. Expected: 0 errors.
2. **Automated Unit Tests:** Run `npm test`. Expected: 31 passed across 6 suites (including `tests/oauth.test.ts` and `tests/webhooks.test.ts`).
3. **Worker Build Verification:** Run `npm run build` (`wrangler deploy --dry-run`). Expected: clean dry-run output with 0 errors.
4. **Local D1 Migrations:** Run `npx wrangler d1 migrations apply invoice-rescue-db --local`. Expected: All 6 migrations applied.
5. **Inspect Detailed Survey Report:** Read `.agents/explorer_survey_backend/report.md` for full schema, route catalog, and gap analysis tables.
