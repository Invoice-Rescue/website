# Adversarial Challenge Report: Milestone M1 (Multi-Tenant Data Architecture - R1)

## Challenge Summary

- **Challenger**: Challenger 1 (Empirical Challenger)
- **Milestone**: M1 — Multi-Tenant Data Architecture & Accounting Synchronization (R1)
- **Overall Risk Assessment**: **HIGH**
- **Verdict**: **REJECT** (Blocking until Challenge 1 authentication bypass on OAuth management routes is addressed)

---

## Empirical Verification Summary

| Test Area | Scope / Hypotheses Tested | Test Count | Result |
|---|---|---|---|
| **Multi-Tenant Repository Isolation** | `getTenantInvoices`, `getTenantInvoiceByNumber`, `getTenantInvoiceById`, `TenantRepository` class, cross-tenant draft modifications | 5 | **PASS** |
| **Duplicate Invoice Number Concurrency** | 10 tenants concurrently holding identical invoice number (`INV-100`), rapid 50-step upsert idempotency | 2 | **PASS** |
| **Atomic Paid Status Preservation** | `upsertTenantInvoice` non-downgrade SQL invariant, `SyncService.reconcileInvoice` stale sync protection, automatic chase draft suppression | 3 | **PASS** |
| **Cryptographic Webhooks & Deduplication** | 30x replay flood deduplication, Xero ITR probe validation, tampered HMAC signature rejection | 2 | **PASS** |
| **Input Fuzzing & SQL Injection** | Malicious non-integer, negative, NaN, string, and SQL injection inputs on `validateClientId` | 1 | **PASS** |
| **Portal Dashboard Isolation** | Session-scoped `/portal/dashboard` segregation of invoices and debtors | 1 | **PASS** |
| **OAuth Route Authorization & Snooping** | `/api/oauth/:provider/connect`, `/status`, `/refresh`, `/disconnect` boundary probing | 2 | **FAIL (VULNERABILITY IDENTIFIED)** |

---

## Challenges

### [CRITICAL] Challenge 1: Unauthenticated Tenant Disconnect, Refresh, and Status Snooping via Body/Query `client_id`

- **Assumption Challenged**:
  The system assumes that accounting connections can only be modified or queried by their legitimate tenant owner or authenticated operator, satisfying Acceptance Criterion 1: *"Multi-tenancy isolation guarantees that queries for one client or tenant cannot read or modify another tenant's invoices or connections."*
- **Attack Scenario**:
  In `backend/src/index.ts` lines 1152–1156 (`handleOAuthDisconnect`):
  ```typescript
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  let clientId: number | null = await authenticateClient(request, env.PORTAL_SESSION_SECRET);
  if (clientId === null && typeof body.client_id === 'number') {
    clientId = body.client_id;
  }
  ```
  And similarly in `handleOAuthRefresh` (lines 1091–1095) and `handleOAuthStatus` (lines 1194–1198):
  If the incoming HTTP request is unauthenticated (`authenticateClient` returns `null`), the handler directly adopts `body.client_id` (or `url.searchParams.get("client_id")`) as the active tenant ID without verifying any credentials (no session cookie, no bearer token, no HTTP Basic Auth).
  
  **Empirical Exploit Demonstration**:
  1. Client 2 has an active Xero accounting connection in D1 (`accounting_connections.client_id = 2`).
  2. An anonymous attacker sends an unauthenticated HTTP POST:
     ```http
     POST /api/oauth/xero/disconnect HTTP/1.1
     Content-Type: application/json

     { "client_id": 2 }
     ```
  3. The Worker accepts `clientId = 2`, queries `accounting_connections` for Client 2, attempts token revocation, deletes the connection record (`DELETE FROM accounting_connections WHERE id = ?1`), sets `clients.accounting_source = NULL`, and responds with `HTTP 200 { "ok": true, "disconnected": "xero" }`.
  4. Client 2's production accounting connection is permanently deleted by an unauthenticated third party.
  5. Similarly, an unauthenticated `GET /api/oauth/xero/status?client_id=2` returns Client 2's external `tenant_id`, connection status, and synchronization timestamps.
- **Blast Radius**:
  Any unauthenticated actor or competing tenant can disconnect all active accounting connections across the entire platform, trigger forced token refreshes, and enumerate connected tenant organizations and accounting providers.
- **Mitigation**:
  1. Remove the unauthenticated fallback `if (clientId === null && typeof body.client_id === 'number') clientId = body.client_id;` from `handleOAuthDisconnect`, `handleOAuthRefresh`, and `handleOAuthStatus`.
  2. Enforce strict authentication on all three routes: if `clientId === null`, return `HTTP 401 Unauthorized` immediately.
  3. If administrative access is required for an operator to disconnect a client's integration, require HTTP Basic Auth (`requireAdminAuth(request, env)`), verify the operator credentials, and log the action.

---

### [MEDIUM] Challenge 2: Absence of Global Unique Constraint on External Accounting `tenant_id`

- **Assumption Challenged**:
  The system assumes each accounting connection represents a distinct client organization, but `accounting_connections` only enforces `UNIQUE (client_id, provider)`.
- **Attack Scenario**:
  If Client 1 and Client 2 both connect using OAuth and authorize the identical upstream Xero organization or QuickBooks realmId, two rows exist with the same `tenant_id`. In `backend/src/lib/tenant-repo.ts`:
  ```typescript
  export async function resolveClientByAccountingTenant(
    db: D1Database,
    provider: AccountingProvider,
    tenantId: string
  ): Promise<number | null> {
    const row = await db.prepare(
      `SELECT client_id AS clientId
       FROM accounting_connections
       WHERE provider = ?1 AND tenant_id = ?2 AND status = 'active'`
    ).bind(provider, tenantId.trim()).first<{ clientId: number }>();
    return row ? row.clientId : null;
  }
  ```
  Incoming webhooks for that external tenant ID will resolve arbitrarily to whichever client record SQLite's `.first()` returns, potentially syncing debtor invoices into the wrong tenant.
- **Blast Radius**:
  Cross-tenant synchronization confusion if an accounting organization is linked to multiple platform accounts.
- **Mitigation**:
  Enforce `UNIQUE (provider, tenant_id)` in `accounting_connections` or reject code exchange during OAuth callback if the returned `tenantId` is already bound to an active connection for another client.

---

## Empirical Stress Test Results

Executed via `tests/adversarial-m1.test.ts` (16 tests across 6 suites):

| Scenario | Expected Behavior | Actual Behavior | Result |
|---|---|---|---|
| **Cross-Tenant Invoice Read** | Client 1 cannot fetch Client 2's invoices by list, number, or primary key ID | Returns empty list or `null` | **PASS** |
| **Cross-Tenant Mutation Defense** | Client 1 upserting invoice with Client 2's invoice number does not overwrite Client 2 | Creates distinct row for Client 1; Client 2 row unmodified | **PASS** |
| **Cross-Tenant Draft Modification** | Client 2 attempting to approve or skip Client 1's draft | Returns `false`; draft remains untouched | **PASS** |
| **ClientId Type Fuzzing & SQL Injection** | Negative, zero, float, string, and SQL injection payloads on `validateClientId` | Throws `InvalidTenantError` | **PASS** |
| **Identical Invoice Number Concurrency** | 10 clients concurrently hold `INV-100` | All 10 succeed, records completely isolated | **PASS** |
| **High Volume Upsert Stress** | 50 rapid sequential updates of same invoice number | Exactly 1 row in D1, latest state stored | **PASS** |
| **Paid Status Invariant (Upsert / CSV)** | Stale update claiming `overdue` on settled invoice | `status` remains `paid`, `paid_date` preserved | **PASS** |
| **Paid Status Invariant (SyncService)** | Stale sync with `isPaid: false` on settled invoice | Returns `unchanged`, `paid` preserved | **PASS** |
| **Settlement Draft Suppression** | Reconciling invoice as paid cancels pending draft | Draft status set to `skipped` with timestamp | **PASS** |
| **Dispute Draft Suppression** | Reconciling invoice as disputed cancels pending draft | Draft status set to `skipped` with timestamp | **PASS** |
| **Webhook Deduplication Flood** | 30 rapid duplicate submissions of same eventId | 1 accepted (`true`), 29 rejected (`false`) | **PASS** |
| **HMAC Signature Tampering** | Bit flip in `x-xero-signature` header | Returns `HTTP 401 Unauthorized` | **PASS** |
| **Portal Dashboard Isolation** | Authenticated Client 1 loads `/portal/dashboard` | Shows Client 1 data, 0 references to Client 2 | **PASS** |
| **OAuth Connect Spoofing Defense** | Authenticated Client 1 requests `connect?client_id=2` | Signed state binds to `cid: 1`, ignores param | **PASS** |
| **OAuth Status Spoofing Defense** | Authenticated Client 1 requests `status?client_id=2` | Returns Client 1 status, ignores param | **PASS** |
| **Unauthenticated Disconnect Probe** | Anonymous caller POSTs `disconnect` with `{ client_id: 2 }` | Returned `HTTP 200` and deleted Client 2 connection | **FAIL (Challenge 1)** |

---

## Unchallenged Areas

- **M2 Statutory Calculation & Cadence Escalation**: Out of scope for M1; evaluated in M2.
- **M3 WCAG 2.2 Level AA DOM Elements**: Frontend portal UI components are scheduled for M3.
- **M4 Production Cloudflare Access & Email Routing**: Cloudflare Access configuration and live email delivery are scheduled for M4.

---

## Final Recommendation

1. **REJECT Milestone M1** until Challenge 1 (unauthenticated OAuth disconnect, refresh, and status fallback) is patched in `backend/src/index.ts`.
2. The core repository layer (`tenant-repo.ts`), database constraints (`UNIQUE(client_id, invoice_number)`), atomic status preservation, and webhook cryptographic validation are empirically sound and passed all stress tests.
3. Once the 3 lines granting unauthenticated `client_id` fallback in `backend/src/index.ts` are removed and replaced with strict `HTTP 401` enforcement, Milestone M1 will satisfy all criteria for immediate approval.
