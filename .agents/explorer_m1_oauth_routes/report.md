# OAuth 2.0 Integration & Routes Architecture Design Report (M1 / R1)

**Role:** M1 OAuth Routes Explorer  
**Project:** Invoice Rescue  
**Status:** Authoritative Architectural Design  
**Target Milestone:** Milestone M1 (Multi-Tenant Data Architecture & Accounting Synchronization)  
**Target Runtime:** Cloudflare Workers Edge Runtime (`nodejs_compat`, zero external runtime dependencies), Cloudflare D1 SQLite  
**Date:** 2026-09-16  

---

## 1. Executive Summary & Core Invariants

This document establishes the authoritative technical design and implementation blueprint for Milestone M1's OAuth 2.0 connection lifecycle, supporting **Xero** and **QuickBooks (Intuit)**.

### Core System Invariants:
1. **Zero External Runtime Dependencies:** All OAuth handshakes, HTTP token exchanges, cryptographic state generation, and token encryptions must execute exclusively via standard Web Platform APIs (`fetch`, `Request`, `Response`, `URL`, `URLSearchParams`, `btoa`, `atob`, and `crypto.subtle`). No external SDKs (such as `xero-node`, `intuit-oauth`, `axios`, or `jsonwebtoken`) are permitted.
2. **AES-GCM (256-bit) Encryption at Rest:** No access or refresh token is ever stored in plaintext. In accordance with database migration `0006_accounting_connections_and_external_sync.sql`, tokens are symmetrically encrypted using Web Crypto AES-GCM with a unique, cryptographically random 12-byte IV per encryption and an authenticated 16-byte tag.
3. **Stateless HMAC-SHA256 Anti-CSRF State Parameter:** In a serverless edge architecture with multiple colos and zero in-memory session persistence between requests, the OAuth `state` parameter is implemented as a cryptographically signed, tamper-evident, time-bounded HMAC token containing client identity, provider, expiration, and random entropy.
4. **Multi-Tenant Scoping & Single-Provider Invariant:** Every connection is strictly scoped by `client_id REFERENCES clients(id)`. Table constraint `UNIQUE (client_id, provider)` guarantees at most one active integration per provider per tenant.
5. **Rolling Refresh Token Handling:** Both Xero and QuickBooks issue a new refresh token with each refresh operation. The refresh engine safely replaces and re-encrypts both the access token and the refresh token atomically.

---

## 2. Provider Specifications & Lifecycle Matrix

| Specification Attribute | Xero Specification | QuickBooks (Intuit) Specification |
| :--- | :--- | :--- |
| **Protocol Flow** | OAuth 2.0 Authorization Code (Web App / Confidential Client) | OAuth 2.0 Authorization Code (Confidential Client) |
| **Authorization URL** | `https://login.xero.com/identity/connect/authorize` | `https://appcenter.intuit.com/connect/oauth2` |
| **Token Exchange URL** | `https://identity.xero.com/connect/token` | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| **Revocation URL** | `https://identity.xero.com/connect/revocation` | `https://developer.api.intuit.com/v2/oauth2/tokens/revoke` |
| **Tenant Discovery URL** | `https://api.xero.com/connections` (Authenticated via Bearer token) | Directly provided as `realmId` query parameter in callback redirect URL |
| **Required Scopes** | `offline_access accounting.transactions accounting.contacts.read accounting.settings.read openid profile email` | `com.intuit.quickbooks.accounting openid email` |
| **Token Endpoint Auth** | HTTP Basic Auth: `Authorization: Basic base64(client_id:client_secret)` | HTTP Basic Auth: `Authorization: Basic base64(client_id:client_secret)` |
| **Access Token TTL** | 1,800 seconds (30 minutes) | 3,600 seconds (60 minutes) |
| **Refresh Token TTL** | 60 days (Rolling: invalidated when refreshed) | 100 days (Rolling: invalidated when refreshed) |
| **Tenant Identifier** | Xero `tenantId` (UUID string, e.g. `2fe6e488-...`) | Intuit `realmId` (Numeric string, e.g. `123146182...`) |
| **API Base URL** | `https://api.xero.com/api.xro/2.0` (Requires header `Xero-Tenant-Id: <tenantId>`) | `https://quickbooks.api.intuit.com/v3/company/<realmId>` |

---

## 3. Cryptographic Architecture & Security Specification

### 3.1 AES-GCM (256-bit) Token Encryption at Rest
The implementation in `backend/src/lib/integrations/oauth-manager.ts` satisfies NIST SP 800-38D standards:

- **Key Derivation:**
  ```typescript
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode(secretKey));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyMaterial,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  ```
- **IV Generation:** Exactly 12 cryptographically random bytes generated via `crypto.getRandomValues(new Uint8Array(12))`.
- **Packaging:** `[12 bytes IV] || [Ciphertext with 16 bytes Auth Tag]`, Base64-encoded for storage in D1 SQLite text columns (`access_token_encrypted`, `refresh_token_encrypted`).
- **Tamper Resistance:** Any bit alteration in storage triggers an authentication tag mismatch during `crypto.subtle.decrypt`, causing it to reject and throw immediately.

### 3.2 Stateless HMAC-SHA256 OAuth State Parameter
Because Cloudflare Workers are stateless across edge locations, storing state in memory or KV creates latency and cache-invalidation challenges. Instead, the system uses self-contained, signed HMAC tokens (consistent with `backend/src/lib/portal-auth.ts`).

#### State Payload Structure:
```typescript
export interface OAuthStatePayload {
  cid: number;                  // Client ID (tenant binding)
  p: 'xero' | 'quickbooks';     // Provider
  nonce: string;                // 16 bytes hex entropy (anti-CSRF)
  exp: number;                  // Expiration timestamp in seconds (now + 600s)
  ret: string;                  // Final redirect target (e.g. '/portal/dashboard' or '/admin')
}
```

#### Token Packaging:
$$\text{state} = \text{base64url}(\text{JSON}(\text{payload})) + "." + \text{base64url}(\text{HMAC-SHA256}(\text{payloadB64}, K))$$
Where $K = \text{env.PORTAL\_SESSION\_SECRET}$ (or $\text{env.TOKEN\_ENCRYPTION\_SECRET}$).

#### Verification Rules:
1. State string must contain exactly one `.` delimiter.
2. Base64url decode both payload and signature.
3. Cryptographically verify signature using `crypto.subtle.verify("HMAC", ...)`.
4. Validate `payload.exp > Math.floor(Date.now() / 1000)`.
5. Validate `payload.p === provider` from route parameter.
6. Validate `payload.cid` exists as an active client in D1 SQLite.
7. Optional Defense-in-depth: If initiator was a browser session, check matching `oauth_nonce` cookie.

---

## 4. Cloudflare Worker OAuth Route Inventory & Router Design

The Cloudflare Worker router in `backend/src/index.ts` will dispatch the following route patterns:

```
GET  /api/oauth/:provider/connect       → Initiates flow, generates state, redirects to provider
GET  /api/oauth/:provider/callback      → Validates state, exchanges code, encrypts, stores in D1
POST /api/oauth/:provider/refresh       → Refreshes tokens on demand or on schedule, updates D1
POST /api/oauth/:provider/disconnect    → Revokes tokens at provider, cleans up D1 connection
GET  /api/oauth/:provider/status        → Returns safe connection status metadata
```

### 4.1 Route 1: `GET /api/oauth/:provider/connect`

#### Route Matching Regex:
```typescript
const connectMatch = path.match(/^\/api\/oauth\/(xero|quickbooks)\/connect$/);
```

#### Request Flow:
1. **Authentication & Tenant Binding:**
   - Case A (Client Self-Serve): Extracted from authenticated portal cookie via `authenticateClient(request, env.PORTAL_SESSION_SECRET)`.
   - Case B (Operator/Admin Initiated): If request contains `requireAdminAuth(request, env) === null`, extracts `client_id` from query string (`?client_id=123`).
   - If unauthenticated or `clientId` missing/invalid: return HTTP 401 / 400.
2. **Provider Validation:** Route ensures provider is strictly `'xero'` or `'quickbooks'`.
3. **State Generation:**
   - Generate 16 bytes random hex for `nonce`.
   - Set `exp = Math.floor(Date.now() / 1000) + 600` (10 minutes validity).
   - Set `ret = url.searchParams.get("return_to") || "/portal/dashboard"`.
   - Sign state payload using HMAC-SHA256.
4. **Redirect URI Resolution:**
   - Redirect URI is `${url.origin}/api/oauth/${provider}/callback`.
   - (Or configurable via `env.OAUTH_REDIRECT_BASE_URL` if behind custom vanity domains).
5. **Construct Provider Authorization URL:**
   - **Xero:**
     ```text
     https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${env.XERO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(XERO_SCOPES)}&state=${state}
     ```
   - **QuickBooks:**
     ```text
     https://appcenter.intuit.com/connect/oauth2?client_id=${env.QUICKBOOKS_CLIENT_ID}&response_type=code&scope=${encodeURIComponent(QB_SCOPES)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}
     ```
6. **Response:**
   - HTTP 302 Found (or 303 See Other) with `Location: <authUrl>`.
   - Set cookie: `oauth_nonce=${nonce}; Path=/api/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`.

---

### 4.2 Route 2: `GET /api/oauth/:provider/callback`

#### Route Matching Regex:
```typescript
const callbackMatch = path.match(/^\/api\/oauth\/(xero|quickbooks)\/callback$/);
```

#### Request Flow:
1. **Check for Provider Errors:**
   - If `url.searchParams.get("error")`:
     - Provider error (e.g. user clicked "Cancel"): `error=access_denied&error_description=...`.
     - Extract `error_description`, log warning, and redirect to `${returnTo}?oauth_error=${encodeURIComponent(desc)}`.
2. **State Verification:**
   - Extract `state = url.searchParams.get("state")`.
   - Verify HMAC signature against `env.PORTAL_SESSION_SECRET` or `env.TOKEN_ENCRYPTION_SECRET`.
   - Verify `payload.exp > Date.now() / 1000`.
   - Verify `payload.p === provider`.
   - If invalid: return HTTP 400 Bad Request with `{ ok: false, error: "Invalid or expired OAuth state parameter." }`.
3. **Exchange Authorization Code for Tokens:**
   - Extract `code = url.searchParams.get("code")`.
   - If missing: return HTTP 400 Bad Request.
   - Dispatch POST request using native `fetch()`:
     - Target:
       - Xero: `https://identity.xero.com/connect/token`
       - QuickBooks: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
     - Headers:
       - `Authorization`: `Basic ${btoa(clientId + ":" + clientSecret)}`
       - `Content-Type`: `application/x-www-form-urlencoded`
       - `Accept`: `application/json`
     - Body:
       ```typescript
       new URLSearchParams({
         grant_type: "authorization_code",
         code,
         redirect_uri: redirectUri,
       }).toString()
       ```
   - If response `!res.ok`:
     - Parse error JSON or text.
     - Log failure (without logging raw secret credentials).
     - Return HTTP 502 Bad Gateway or redirect with `oauth_error=token_exchange_failed`.
   - Parse Token Response:
     - `accessToken = tokenData.access_token`
     - `refreshToken = tokenData.refresh_token`
     - `expiresIn = tokenData.expires_in` (seconds)
4. **Tenant ID Resolution:**
   - **QuickBooks:**
     - Intuit returns `realmId` directly as query parameter in the callback URL:
       `tenantId = url.searchParams.get("realmId")`.
     - If missing: throw error "QuickBooks realmId missing from callback".
   - **Xero:**
     - Must call Xero Connections endpoint:
       `GET https://api.xero.com/connections`
       Headers: `Authorization: Bearer ${accessToken}`, `Accept: application/json`
     - Parse array of tenant records:
       `[{ id, tenantId, tenantType, tenantName }]`
     - Find active organisation:
       `const org = connections.find(c => c.tenantType === "ORGANISATION") || connections[0];`
       `tenantId = org.tenantId;`
5. **Encrypt Tokens via Web Crypto AES-GCM:**
   - `accessTokenEncrypted = await encryptToken(accessToken, env.TOKEN_ENCRYPTION_SECRET)`
   - `refreshTokenEncrypted = await encryptToken(refreshToken, env.TOKEN_ENCRYPTION_SECRET)`
   - `expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()`
6. **Store in D1 SQLite Database (`accounting_connections`):**
   - Execute atomic upsert with SQLite constraint handling:
     ```sql
     INSERT INTO accounting_connections (
       client_id, provider, tenant_id,
       access_token_encrypted, refresh_token_encrypted,
       expires_at, status, last_synced_at, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', NULL, datetime('now'))
     ON CONFLICT(client_id, provider) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       expires_at = excluded.expires_at,
       status = 'active';
     ```
   - Update `clients` record:
     ```sql
     UPDATE clients SET accounting_source = ?2 WHERE id = ?1;
     ```
7. **Final Redirect / Response:**
   - Redirect to client portal dashboard:
     `return new Response(null, { status: 303, headers: { Location: `${payload.ret}?connected=${provider}` } });`

---

### 4.3 Route 3: Token Refresh Engine & `POST /api/oauth/:provider/refresh`

#### Route Matching Regex:
```typescript
const refreshMatch = path.match(/^\/api\/oauth\/(xero|quickbooks)\/refresh$/);
```

#### Refresh Engine Logic (Reusable in both Route and Cron/Sync):
```typescript
export async function refreshAccountingConnection(
  db: D1Database,
  env: Env,
  connectionId: number
): Promise<{ success: boolean; accessToken?: string; error?: string }>
```

1. **Load Connection Row:**
   ```sql
   SELECT id, client_id, provider, tenant_id, refresh_token_encrypted, expires_at, status
   FROM accounting_connections
   WHERE id = ?1
   ```
2. **Decrypt Stored Refresh Token:**
   `const refreshToken = await decryptToken(conn.refresh_token_encrypted, env.TOKEN_ENCRYPTION_SECRET);`
3. **Dispatch Refresh Request to Provider:**
   - Method: `POST`
   - Headers: `Authorization: Basic ${btoa(clientId + ":" + clientSecret)}`, `Content-Type: application/x-www-form-urlencoded`
   - Body:
     ```typescript
     new URLSearchParams({
       grant_type: "refresh_token",
       refresh_token: refreshToken,
     }).toString()
     ```
4. **Handle Provider Error States:**
   - If HTTP 400 with `error === "invalid_grant"`:
     - User revoked consent in accounting console or refresh token expired.
     - Execute:
       ```sql
       UPDATE accounting_connections SET status = 'revoked' WHERE id = ?1;
       ```
     - Return `{ success: false, error: "revoked" }`.
   - If HTTP 5xx / Network Error:
     - Do not overwrite valid refresh token!
     - Set `status = 'expired'` so subsequent sync passes retry.
     - Return `{ success: false, error: "network_error" }`.
5. **Process Rolling Refresh Token:**
   - Both Xero and Intuit return a **brand new** `refresh_token`.
   - Encrypt both new tokens:
     - `newAccessEncrypted = await encryptToken(newTokens.access_token, env.TOKEN_ENCRYPTION_SECRET)`
     - `newRefreshEncrypted = await encryptToken(newTokens.refresh_token, env.TOKEN_ENCRYPTION_SECRET)`
     - `newExpiresAt = new Date(Date.now() + newTokens.expires_in * 1000).toISOString()`
6. **Persist to D1:**
   ```sql
   UPDATE accounting_connections
   SET access_token_encrypted = ?2,
       refresh_token_encrypted = ?3,
       expires_at = ?4,
       status = 'active'
   WHERE id = ?1;
   ```
7. **Return Decrypted Access Token for Immediate API Usage:**
   - Return `{ success: true, accessToken: newTokens.access_token }`.

---

### 4.4 Route 4: `POST /api/oauth/:provider/disconnect`

#### Route Matching Regex:
```typescript
const disconnectMatch = path.match(/^\/api\/oauth\/(xero|quickbooks)\/disconnect$/);
```

#### Request Flow:
1. **Authorization Verification:**
   - Client session cookie or admin basic auth check.
2. **Retrieve Connection:**
   - Query: `SELECT id, refresh_token_encrypted FROM accounting_connections WHERE client_id = ?1 AND provider = ?2`.
   - If no connection exists: return HTTP 404 `{ ok: false, error: "No active connection found." }`.
3. **Best-Effort Upstream Revocation:**
   - Decrypt refresh token.
   - Dispatch revocation call to provider:
     - **Xero:** `POST https://identity.xero.com/connect/revocation` (`token=${refreshToken}`, Basic Auth).
     - **QuickBooks:** `POST https://developer.api.intuit.com/v2/oauth2/tokens/revoke` (`{"token": "${refreshToken}"}`, Basic Auth).
   - Ignore upstream errors if already revoked.
4. **Database Cleanup:**
   - Clean deletion or mark revoked:
     ```sql
     DELETE FROM accounting_connections WHERE client_id = ?1 AND provider = ?2;
     ```
   - Update client source:
     ```sql
     UPDATE clients SET accounting_source = NULL WHERE id = ?1 AND accounting_source = ?2;
     ```
5. **Response:**
   - Return HTTP 200 `{ ok: true, disconnected: provider }`.

---

### 4.5 Route 5: `GET /api/oauth/:provider/status`

#### Route Matching Regex:
```typescript
const statusMatch = path.match(/^\/api\/oauth\/(xero|quickbooks)\/status$/);
```

#### Behavior:
- Queries `accounting_connections` for `client_id` and `provider`.
- Returns sanitized JSON:
  ```json
  {
    "ok": true,
    "connected": true,
    "provider": "xero",
    "status": "active",
    "tenant_id": "2fe6e488-...",
    "expires_at": "2026-09-16T07:15:00.000Z",
    "last_synced_at": "2026-09-16T06:00:00.000Z"
  }
  ```
- **Security Check:** Strictly NEVER returns `access_token_encrypted`, `refresh_token_encrypted`, or decrypted tokens.

---

## 5. Parameter Parsing, Validation & Error Responses

### Standard Error Response Format:
All error responses adhere to the standard security headers and JSON shape:
```json
{
  "ok": false,
  "error": "Descriptive error message"
}
```

### HTTP Status Code Specifications:
| Scenario | HTTP Status | Description / Error Message |
| :--- | :--- | :--- |
| **Missing / Invalid Client** | `401 Unauthorized` / `400 Bad Request` | `"Client authentication required."` / `"Invalid client_id."` |
| **Invalid Provider** | `400 Bad Request` | `"Invalid provider: must be xero or quickbooks."` |
| **Tampered State Parameter** | `400 Bad Request` | `"Invalid OAuth state signature."` |
| **Expired State Parameter** | `400 Bad Request` | `"OAuth state expired. Please restart the connection."` |
| **Provider Auth Denied** | `303 Redirect` or `400 Bad Request` | Redirects to dashboard with `?oauth_error=access_denied` |
| **Code Exchange Failed** | `502 Bad Gateway` | `"Failed to exchange authorization code with accounting provider."` |
| **Xero Connections Empty** | `502 Bad Gateway` | `"No authorized Xero organizations found for this account."` |
| **QuickBooks realmId Missing** | `400 Bad Request` | `"QuickBooks realmId was not provided in callback."` |
| **Provider Token Refresh Revoked**| `401 Unauthorized` | `"Accounting authorization has been revoked by user. Re-authentication required."` |
| **Encryption Failure** | `500 Internal Server Error` | Generic error response; stack trace logged securely server-side. |

---

## 6. Environment & Secret Configuration Blueprint

The following environment variables and secrets must be declared in `wrangler.jsonc` and `worker-configuration.d.ts`:

### 1. Variables (`wrangler.jsonc` `vars`):
```jsonc
"vars": {
  // Existing vars...
  "OAUTH_REDIRECT_BASE_URL": "https://invoicerescue.co.uk",
  "QUICKBOOKS_ENVIRONMENT": "sandbox" // "sandbox" or "production"
}
```

### 2. Secrets (Stored securely via `wrangler secret put`):
```bash
# Token encryption secret (minimum 32-character random string for AES-256)
npx wrangler secret put TOKEN_ENCRYPTION_SECRET

# Xero App Credentials (from https://developer.xero.com/app/manage)
npx wrangler secret put XERO_CLIENT_ID
npx wrangler secret put XERO_CLIENT_SECRET
npx wrangler secret put XERO_WEBHOOK_KEY

# QuickBooks App Credentials (from https://developer.intuit.com/app/developer/dashboard)
npx wrangler secret put QUICKBOOKS_CLIENT_ID
npx wrangler secret put QUICKBOOKS_CLIENT_SECRET
npx wrangler secret put QUICKBOOKS_VERIFIER_TOKEN
```

---

## 7. Zero-Dependency Mock & Offline Test Architecture

In strict adherence to rule R4 and testing guidelines, automated test runs (`npm test` via `tsx --test tests/**/*.test.ts`) must run 100% offline with zero external network access, completing in under 2 seconds.

### 7.1 Offline Mock Implementation Pattern

We design a native mock provider that intercepts `globalThis.fetch` or passes an optional `fetchFn` to `oauth-manager`:

```typescript
export interface MockOAuthServer {
  setup(): void;
  teardown(): void;
}

export function setupOAuthMocks(): void {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();

    // 1. Mock Xero Token Exchange
    if (url === "https://identity.xero.com/connect/token") {
      const body = init?.body?.toString() ?? "";
      if (body.includes("grant_type=authorization_code")) {
        if (body.includes("code=invalid_code")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        return new Response(JSON.stringify({
          access_token: "mock-xero-access-token-123",
          refresh_token: "mock-xero-refresh-token-123",
          token_type: "Bearer",
          expires_in: 1800,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (body.includes("grant_type=refresh_token")) {
        return new Response(JSON.stringify({
          access_token: "mock-xero-new-access-token-456",
          refresh_token: "mock-xero-new-refresh-token-456",
          token_type: "Bearer",
          expires_in: 1800,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }

    // 2. Mock Xero Connections Discovery
    if (url === "https://api.xero.com/connections") {
      return new Response(JSON.stringify([
        {
          id: "conn-uuid-1",
          tenantId: "xero-org-tenant-uuid-123",
          tenantType: "ORGANISATION",
          tenantName: "Acme UK Ltd"
        }
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 3. Mock QuickBooks Token Exchange
    if (url === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
      return new Response(JSON.stringify({
        access_token: "mock-qb-access-token-789",
        refresh_token: "mock-qb-refresh-token-789",
        token_type: "bearer",
        expires_in: 3600,
        x_refresh_token_expires_in: 8726400,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 4. Fallback to original fetch
    return originalFetch(input, init);
  };
}
```

### 7.2 Unit Test Matrix (`tests/oauth.test.ts`):
1. **State Token Security:**
   - Signs state with client ID and provider.
   - Verifies valid state.
   - Rejects tampered state (modified payload or modified signature).
   - Rejects expired state.
2. **Authorization URL Builder:**
   - Verifies correct scopes for Xero (`offline_access`, `accounting.transactions`, etc.).
   - Verifies correct scopes for QuickBooks (`com.intuit.quickbooks.accounting`).
   - Verifies correct query parameters and state inclusion.
3. **Token Exchange & Tenancy:**
   - Exchanges code for Xero and resolves tenant ID from `/connections`.
   - Exchanges code for QuickBooks and extracts `realmId`.
   - Encrypts tokens with AES-GCM and verifies that ciphertext does NOT equal plaintext.
4. **D1 Storage & Client Association:**
   - Verifies insertion into `accounting_connections`.
   - Verifies upsert on re-authorization.
   - Verifies update to `clients.accounting_source`.
5. **Rolling Token Refresh:**
   - Verifies token decryption.
   - Simulates rolling token update and confirms new refresh token is stored.
   - Verifies handling of `invalid_grant` transitioning status to `revoked`.
6. **Disconnection:**
   - Verifies revocation call and clean removal or status update in D1.

---

## 8. Implementation Code Blueprint

Below are the exact implementation blueprints ready for M1 implementers:

### Blueprint 1: `backend/src/lib/integrations/oauth-manager.ts`
```typescript
/**
 * OAuth 2.0 Manager for Xero and QuickBooks
 * Zero-external-dependency implementation using Web Crypto and native fetch.
 */

export interface OAuthStatePayload {
  cid: number;
  p: 'xero' | 'quickbooks';
  nonce: string;
  exp: number;
  ret: string;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantId: string;
}

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";
const XERO_SCOPES = "offline_access accounting.transactions accounting.contacts.read accounting.settings.read openid profile email";

const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QB_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const QB_SCOPES = "com.intuit.quickbooks.accounting openid email";

/** Utility: Base64URL encoding/decoding */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Generates a signed, tamper-proof state token */
export async function generateOAuthState(
  payload: Omit<OAuthStatePayload, 'exp' | 'nonce'>,
  secretKey: string,
  ttlSeconds = 600
): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  const fullPayload: OAuthStatePayload = { ...payload, nonce, exp };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Verifies and parses an OAuth state token */
export async function verifyOAuthState(
  state: string,
  secretKey: string,
  expectedProvider: 'xero' | 'quickbooks'
): Promise<OAuthStatePayload | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const payloadBytes = fromBase64Url(payloadB64);
  const sigBytes = fromBase64Url(sigB64);
  if (!payloadBytes || !sigBytes) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payloadB64));
  if (!isValid) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (payload.p !== expectedProvider) return null;
  if (typeof payload.cid !== "number" || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

/** Constructs the provider authorization redirect URL */
export function buildAuthorizationUrl(
  provider: 'xero' | 'quickbooks',
  clientId: string,
  redirectUri: string,
  state: string
): string {
  if (provider === 'xero') {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: XERO_SCOPES,
      state,
    });
    return `${XERO_AUTH_URL}?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      scope: QB_SCOPES,
      redirect_uri: redirectUri,
      state,
    });
    return `${QB_AUTH_URL}?${params.toString()}`;
  }
}

/** Exchanges authorization code for tokens and resolves tenant ID */
export async function exchangeCodeForTokens(
  provider: 'xero' | 'quickbooks',
  code: string,
  redirectUri: string,
  clientCredentials: { clientId: string; clientSecret: string },
  realmId?: string | null
): Promise<TokenExchangeResult> {
  const tokenUrl = provider === 'xero' ? XERO_TOKEN_URL : QB_TOKEN_URL;
  const basicAuth = btoa(`${clientCredentials.clientId}:${clientCredentials.clientSecret}`);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }

  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  let tenantId = "";
  if (provider === 'quickbooks') {
    if (!realmId) throw new Error("QuickBooks realmId missing from callback");
    tenantId = realmId;
  } else {
    // Xero tenant resolution via /connections
    const connRes = await fetch(XERO_CONNECTIONS_URL, {
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Accept": "application/json",
      },
    });
    if (!connRes.ok) {
      throw new Error(`Xero connections fetch failed: ${await connRes.text()}`);
    }
    const connections = (await connRes.json()) as Array<{ tenantId: string; tenantType: string }>;
    if (!connections || connections.length === 0) {
      throw new Error("No connected Xero organization found");
    }
    const org = connections.find(c => c.tenantType === "ORGANISATION") || connections[0];
    tenantId = org.tenantId;
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    tenantId,
  };
}
```

---

## 9. Conclusion & Implementer Recommendations

1. **Self-Contained & Production-Ready:** The architectural design requires zero external libraries, maintains complete edge compatibility (R4), and provides cryptographic tamper-proofing for state tokens and stored credentials (R1).
2. **Immediate Implementation Path:**
   - Implement `generateOAuthState`, `verifyOAuthState`, `buildAuthorizationUrl`, and `exchangeCodeForTokens` in `backend/src/lib/integrations/oauth-manager.ts`.
   - Wire route patterns into `backend/src/index.ts` under `/api/oauth/:provider/*`.
   - Add unit tests with mock fetch handlers in `tests/oauth.test.ts`.
3. **Clean D1 Migration:** Uses existing table `accounting_connections` created in `0006_accounting_connections_and_external_sync.sql` without requiring additional migrations.
