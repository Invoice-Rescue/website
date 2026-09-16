# Handoff Report: Milestone M1 OAuth 2.0 Routes & Connection Lifecycle

**Sender:** M1 OAuth Routes Explorer  
**Recipient:** Orchestrator & M1 Implementers  
**Working Directory:** `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_oauth_routes`  
**Handoff Type:** Hard Handoff (Task Complete)  
**Date:** 2026-09-16  

---

## 1. Observation

1. **Existing Cryptographic Functions:**
   - In `backend/src/lib/integrations/oauth-manager.ts` (lines 1–57), `encryptToken(plaintext, secretKey)` and `decryptToken(ciphertextWithIv, secretKey)` are implemented using Web Crypto `AES-GCM` with a 12-byte IV and SHA-256 derived key.
   - Tested in `tests/oauth.test.ts` (lines 5–14), where `assert.strictEqual(decrypted, plaintext)` passes.
2. **Missing OAuth Routes in Router:**
   - In `backend/src/index.ts` (lines 148–231), the `fetch()` handler mounts routes for `/api/health`, `/api/statutory-rate`, `/api/billing/webhook`, `/portal/*`, `/api/lead`, `/api/clients`, `/admin`, and `/api/chase/*`.
   - **Zero** OAuth routes exist: no matching cases for `/api/oauth/*`, no state generation, no callback handler, no refresh endpoint.
3. **Existing Accounting Connections Schema:**
   - In `backend/db/migrations/0006_accounting_connections_and_external_sync.sql` (lines 1–15):
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
     CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_connections_client_provider ON accounting_connections (client_id, provider);
     ```
   - Migration status verified: `npx wrangler d1 migrations apply invoice-rescue-db --local` reports "No migrations to apply", confirming the table and unique index are already active in the D1 schema.
4. **Stateless HMAC Authentication Paradigm in Codebase:**
   - In `backend/src/lib/portal-auth.ts` (lines 11–90), authentication is handled without server-side session stores via HMAC-SHA256 signed tokens of shape `base64url(payload) + "." + base64url(HMAC-SHA256)`.
5. **Zero External Runtime Package Invariant:**
   - In `package.json` (lines 38–46), `dependencies` is empty (`{}`). All dependencies are `devDependencies` (`@cloudflare/workers-types`, `@types/node`, `tsx`, `typescript`, `wrangler`).
   - `npm test` runs in ~1.2s across 31 tests.

---

## 2. Logic Chain

1. **Need for Stateless Anti-CSRF OAuth State Parameter:**
   - *Observation Reference:* Serverless Workers have no cross-request in-memory state, and the runtime has zero runtime packages. `portal-auth.ts` successfully implements HMAC-SHA256 stateless tokens using Web Crypto.
   - *Reasoning:* Implementing OAuth state as a signed token containing `{ cid, p, nonce, exp, ret }` cryptographically prevents CSRF and tenant spoofing without requiring database round-trips before redirecting to the provider.
2. **Tenancy Resolution Divergence Between Providers:**
   - *Observation Reference:* Xero requires calling `https://api.xero.com/connections` with `Authorization: Bearer <access_token>` to find the organisation `tenantId`. QuickBooks passes `realmId` directly in the callback redirect URL parameters.
   - *Reasoning:* The callback handler must branch tenancy resolution based on provider: for QuickBooks, extract `realmId` from URL search parameters; for Xero, execute a subrequest to `/connections` immediately after token exchange and select the primary active organisation.
3. **Rolling Refresh Invalidation & Storage Strategy:**
   - *Observation Reference:* Both Xero and Intuit documentation enforce rolling refresh tokens — using a refresh token invalidates it and issues a new one.
   - *Reasoning:* Token refresh must atomically encrypt both the newly issued `access_token` and `refresh_token`, update `expires_at`, and set `status = 'active'` in `accounting_connections`. If a provider returns `invalid_grant`, the status must transition to `'revoked'`.
4. **Storage & Multi-Tenant Constraint Handling:**
   - *Observation Reference:* Schema `0006` enforces `UNIQUE INDEX ON accounting_connections (client_id, provider)`.
   - *Reasoning:* Insertion must use SQLite `INSERT ... ON CONFLICT(client_id, provider) DO UPDATE SET` to seamlessly handle re-connection without duplicate row constraint crashes.
5. **Offline Test Verification Integrity:**
   - *Observation Reference:* Production CI requires `npm test` to pass 100% without external dependencies or network access.
   - *Reasoning:* The test suite in `tests/oauth.test.ts` must mock provider endpoints (`identity.xero.com`, `api.xero.com`, `oauth.platform.intuit.com`) via `globalThis.fetch` interception, asserting the full lifecycle (connect → callback → encrypt → store → refresh → disconnect).

---

## 3. Caveats

1. **No Scope Elevation Handling:** If a connected Xero organization has restricted permissions (e.g. read-only transactions), the initial OAuth flow will succeed, but subsequent invoice creation or write actions (if implemented in later milestones) would fail.
2. **Provider Clock Skew:** Token expiration calculation uses `Date.now() + expiresIn * 1000`. To prevent edge-case race conditions where an access token expires in transit, a 60-second buffer should be subtracted from `expiresAt`.
3. **Single Active Organization per Tenant:** If a user possesses multiple Xero organizations under one login, the initial implementation picks the first `tenantType: 'ORGANISATION'`. Multi-organization selection UI is out of scope for M1.

---

## 4. Conclusion

1. The architectural design for M1 OAuth 2.0 routes is complete, documented in `report.md`, and completely satisfies R1 and R4.
2. All endpoints (`GET /api/oauth/:provider/connect`, `GET /api/oauth/:provider/callback`, `POST /api/oauth/:provider/refresh`, `POST /api/oauth/:provider/disconnect`, `GET /api/oauth/:provider/status`) can be implemented using zero external runtime dependencies with Web Crypto and native `fetch`.
3. Database schema `accounting_connections` is already active and ready for token persistence with AES-GCM (256-bit) encryption.

---

## 5. Verification Method

### Concrete Verification Commands:
1. **Typecheck Verification:**
   ```powershell
   npx tsc --noEmit
   ```
   *Expected:* Zero TypeScript compilation errors.
2. **Unit Test Suite Execution:**
   ```powershell
   npm test
   ```
   *Expected:* All unit tests pass in < 2 seconds.
3. **Worker Build Verification:**
   ```powershell
   npm run build
   ```
   *Expected:* `wrangler deploy --dry-run` bundles cleanly without errors.
4. **Inspect Design Documentation:**
   - Inspect `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_oauth_routes\report.md` for full blueprints and route matching regex.
