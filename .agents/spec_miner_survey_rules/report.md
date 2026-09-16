# Statutory & Accounting Specification Report (R1 & R2)

**Author:** Statutory & Accounting Spec Miner  
**Project:** Invoice Rescue  
**Status:** Authoritative Specification Baseline  
**Date:** 2026-09-16  
**Target Architecture:** Cloudflare Workers, Cloudflare D1 SQLite, Web Crypto API  

---

## 1. Executive Summary & Authoritative Baseline

This specification defines the functional, mathematical, and cryptographic contracts for **R1 (Multi-Tenant Data Architecture & Accounting Synchronization)** and **R2 (Credit-Control Escalation & Statutory Calculation Engine)** of Invoice Rescue.

The specifications were mined and synthesized from:
1. `ORIGINAL_REQUEST.md` (authoritative customer and functional requirements)
2. `backend/db/migrations/0001` through `0006` (database schema, check constraints, foreign keys, and indexes)
3. Existing backend libraries (`statutory-interest.ts`, `escalation.ts`, `gemini.ts`, `portal-auth.ts`, `stripe.ts`, and `integrations/`)
4. System architecture documents (`docs/credit-control-system-design.md`, `docs/API.md`, `docs/architecture.md`, `docs/reference-docs.md`)
5. Authoritative UK statutes: **Late Payment of Commercial Debts (Interest) Act 1998** as amended by the **Late Payment of Commercial Debts Regulations 2002 and 2013**.

---

## 2. Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|---|---|---|---|---|---|---|
| 1 | R1 Isolation | Multi-Tenant Client Partitioning | Strict row-level tenant boundary by `client_id` across `invoices`, `chase_log`, `accounting_connections`. | `client_id` extracted from authenticated session or validated route param | Scoped query results filtered by `WHERE client_id = ?` | Unauthorized access denied; foreign key violations throw D1 execution error | `0001_initial_schema.sql`, `0003_add_check_constraints.sql`, `portal-auth.ts` |
| 2 | R1 Isolation | Invoice Deduplication Guard | Composite unique constraint `UNIQUE (client_id, invoice_number)` preventing cross-invoice collisions or duplicate imports. | `(client_id, invoice_number)` tuple | Insertion or constraint enforcement | SQLite `SQLITE_CONSTRAINT_UNIQUE` rejected on duplicate insert | `0003_add_check_constraints.sql:73` |
| 3 | R1 Accounting | Xero OAuth 2.0 Lifecycle | Authorization Code flow token exchange, storage, and scheduled rotation for Xero multi-tenant organizations. | Auth code, `client_id`, `client_secret`, `redirect_uri` | Encrypted access/refresh tokens, tenant ID, expiry timestamp | Throws on expired refresh token or invalid grant; sets status to `expired` or `revoked` | `credit-control-system-design.md §4.1`, `0006_accounting_connections_and_external_sync.sql` |
| 4 | R1 Accounting | QuickBooks OAuth 2.0 Lifecycle | Intuit OAuth 2.0 flow exchanging auth code for tokens tied to QuickBooks `realmId`. | Auth code, `realmId`, app client credentials | Encrypted token record, `status = 'active'` | Fails closed on invalid signature/credentials; marks connection `expired` | `credit-control-system-design.md §4.1`, `0006_accounting_connections_and_external_sync.sql` |
| 5 | R1 Crypto | AES-GCM (256-bit) Token Encryption | Symmetrically encrypts access and refresh tokens at rest using Web Crypto `AES-GCM` with random 12-byte IV. | Plaintext token string, secret key string | Base64-encoded string: `[12-byte IV] + [Ciphertext + 16-byte Auth Tag]` | Throws on empty key, invalid key length, or corrupted payload | `oauth-manager.ts`, `tests/oauth.test.ts` |
| 6 | R1 Crypto | AES-GCM (256-bit) Token Decryption | Extracts IV and ciphertext, verifies authentication tag, and decrypts token back to plaintext. | Base64-encoded payload, secret key string | Decrypted plaintext token string | Rejects corrupted ciphertext or wrong key with authentication tag error | `oauth-manager.ts`, `tests/oauth.test.ts` |
| 7 | R1 Webhooks | QuickBooks Webhook HMAC Verification | Validates `intuit-signature` header against HMAC-SHA256 of raw payload using verifier token via timing-safe comparison. | Raw payload string, `intuit-signature` header, `verifierToken` | Boolean (`true` = valid, `false` = invalid) | Fails closed: returns `false` on missing header, empty token, or signature mismatch | `webhooks.ts`, `tests/webhooks.test.ts` |
| 8 | R1 Webhooks | Xero Webhook HMAC Verification | Validates `x-xero-signature` header against HMAC-SHA256 of raw payload using Xero webhook key via timing-safe comparison. | Raw payload string, `x-xero-signature` header, `webhookKey` | Boolean (`true` = valid, `false` = invalid) | Fails closed: returns `false` on payload alteration or invalid secret; returns HTTP 401 | `webhooks.ts`, `tests/webhooks.test.ts` |
| 9 | R1 Webhooks | Accounting Event Deduplication | Records incoming webhook IDs in `accounting_webhook_events` to enforce idempotency and prevent duplicate processing. | Webhook event ID (`id`), `provider`, `event_type`, `payload` | HTTP 200 OK (`duplicate: true`) or proceed with processing | SQLite PK collision causes idempotency check to detect existing row and skip | `0005_webhook_events.sql`, `0006_accounting_connections_and_external_sync.sql`, `index.ts:684` |
| 10 | R1 Sync | Idempotent Invoice Sync Engine | Synchronizes invoice status changes from accounting provider; updates existing invoices or inserts new overdue records. | Accounting invoice payload, `client_id` | Updated/inserted `invoices` row with `last_synced_at` timestamp | Reconciles discrepancies; ignores paid updates for already-settled records | `sync-service.ts`, `0006_accounting_connections_and_external_sync.sql`, `credit-control-system-design.md §4.1` |
| 11 | R2 State Machine | Escalation Cadence Evaluator | Computes the next escalation step (1 to 4) based on days overdue and chase history: `[1, 8, 15, 22]`. | `daysOverdue: number`, `history: ChaseHistoryRow[]` | `nextStep: number | null` (1, 2, 3, 4, or null if exhausted) | Returns `null` if not yet due or if step 4 already attempted | `escalation.ts:19-24`, `tests/escalation.test.ts` |
| 12 | R2 State Machine | Stage 1 (Gentle Reminder) | 1+ days overdue. Friendly nudge assuming invoice was overlooked. No statutory interest mentioned. | `daysOverdue >= 1`, `lastChaseDate === null` | Transition to `stage1_gentle`, draft Gentle reminder | Blocked if invoice is < 1 day overdue | `ORIGINAL_REQUEST.md:34`, `escalation.ts:40-46`, `gemini.ts:49` |
| 13 | R2 State Machine | Stage 2 (Follow-up Reminder) | 7+ days after Stage 1. Polite inquiry regarding payment date and whether anything is disputed. No statutory interest. | `stage1_gentle`, `daysSinceChase >= 7` | Transition to `stage2_followup`, draft Follow-up reminder | Action deferred if `< 7` days since Stage 1 chase | `ORIGINAL_REQUEST.md:35`, `escalation.ts:47-56`, `gemini.ts:50` |
| 14 | R2 State Machine | Stage 3 (Firm Notice) | 7+ days after Stage 2. Firm demand citing payment terms. Formal notification of statutory interest + compensation fee. | `stage2_followup`, `daysSinceChase >= 7` | Transition to `stage3_firm`, draft Firm notice with statutory claim breakdown | Action deferred if `< 7` days since Stage 2 chase | `ORIGINAL_REQUEST.md:36`, `escalation.ts:57-65`, `gemini.ts:51,93-95` |
| 15 | R2 State Machine | Stage 4 (Final Demand) | 7+ days after Stage 3. Final demand with 7-day notice before handing back to client for legal collection. | `stage3_firm`, `daysSinceChase >= 7` | Transition to `stage4_final`, draft Final demand with updated statutory calculations | Action deferred if `< 7` days since Stage 3 chase | `ORIGINAL_REQUEST.md:37`, `escalation.ts:66-74`, `gemini.ts:52` |
| 16 | R2 State Machine | Terminal State: Paid | Marks invoice as settled (`status = 'paid'`, `paid_date = date('now')`). Halts all automated chasing permanently. | Payment confirmation from accounting provider, webhook, or operator | `invoices.status = 'paid'`, `paid_date` stamped | No further chase drafts generated; skipped in overdue detection query | `ORIGINAL_REQUEST.md:38`, `core.ts:3`, `0001_initial_schema.sql:45` |
| 17 | R2 State Machine | Terminal State: Handed Back | 7+ days after Stage 4. Automated recovery exhausted; invoice returned to client for court/collection agency action. | `stage4_final`, `daysSinceChase >= 7` with no payment | `invoices.status = 'escalated'` or `handed_back`, operator review notice | No further automated chases; sequence terminated | `ORIGINAL_REQUEST.md:38`, `escalation.ts:77-79`, `core.ts:1-3` |
| 18 | R2 Statutory | BoE + 8% Daily Statutory Interest | Daily statutory interest accrual: `(Principal * (BaseRate + 8) / 100 / 365) * DaysOverdue`, zero rounding drift. | `amountPence: number`, `daysOverdue: number`, `boeBaseRatePercent: number` | `statutoryInterestPence: number` (integer pence, rounded at end) | Returns 0 for `<= 0` days overdue; clamps negative values | `statutory-interest.ts:19-26`, `tests/statutory-interest.test.ts` |
| 19 | R2 Statutory | Statutory Fixed Compensation Tiers | Legally mandated late fee under 1998 Act (2002/2013 regs): <£1k → £40; £1k–£9,999.99 → £70; >=£10k → £100. | `amountPence: number` | Fixed compensation in pence (`4000`, `7000`, or `10000`) | Throws or clamps on negative principal amount | `statutory-interest.ts:13-17`, `tests/statutory-interest.test.ts` |
| 20 | R2 Sender | Locked Sender Identity Model | Outbound emails strictly lock `FROM: hello@invoicerescue.co.uk` and verbatim sign-off by Tibor Rames on client behalf. | Chase parameters, client business name | Formatted message body ending with mandatory sign-off block | Prompt enforcement: forbids omitted sign-off or modified sender | `gemini.ts:64-70`, `tests/gemini.test.ts:29`, `wrangler.jsonc:53` |
| 21 | R2 Deliverability | Split-Trust Email Routing | Segregation of email trust domains: `NOTIFY` binding for operator internal alerts; `SEND` binding for debtor/client messages. | Outbound email payload, destination address | Dispatched via Cloudflare Workers `send_email` runtime | `NOTIFY` rejects unverified addresses at Cloudflare runtime level | `wrangler.jsonc:37-50`, `index.ts:267,503,824,871`, `credit-control-system-design.md §4.5` |

---

## 3. Edge Cases

| # | Feature | Input | Observed Behavior |
|---|---|---|---|
| 1 | Multi-Tenant Isolation | Authenticated client attempts to query or mutate an invoice belonging to another client | Request is rejected with `404 Not Found` or empty results; SQL filter `WHERE client_id = ?` ensures cross-tenant records do not exist in the query space. |
| 2 | Multi-Tenant Isolation | CSV import with duplicated invoice number within same client | SQLite aborts with `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: invoices.client_id, invoices.invoice_number`. |
| 3 | Multi-Tenant Isolation | CSV import with identical invoice number across two different clients | Allowed and isolated: `(Client A, INV-1)` and `(Client B, INV-1)` both exist independently without collision. |
| 4 | AES-GCM Crypto | Empty secret key string (`secretKey = ""`) provided to `encryptToken` or `decryptToken` | Key derivation produces a 256-bit hash of empty string; however, in production, validation must reject empty secrets to prevent weak key material. |
| 5 | AES-GCM Crypto | Truncated or corrupted Base64 ciphertext (e.g. fewer than 12 bytes for IV, or tampered payload) | `crypto.subtle.decrypt` throws `DOMException: The operation failed for an operation-specific reason` (authentication tag mismatch); fails closed. |
| 6 | Webhook HMAC | Webhook payload modified by 1 single character in transit | HMAC-SHA256 signature mismatch; `timingSafeEqual` returns `false`; endpoint returns HTTP 400/401 and discards payload. |
| 7 | Webhook HMAC | Empty or missing signature header in request | Signature length mismatch in `timingSafeEqual`; returns `false`; immediate HTTP 400 rejection without parsing. |
| 8 | Webhook Deduplication | Identical webhook event delivery received twice within 5 seconds | First request inserts into `accounting_webhook_events` and processes; second request finds existing `id` and returns `{ ok: true, duplicate: true }` without repeating actions. |
| 9 | State Machine | Invoice is exactly 0 days overdue (due date is today) | `daysOverdue = 0`. `nextStepDue(0, [])` returns `null`. State machine remains in `new` stage with message "Not yet overdue — no action". |
| 10 | State Machine | Invoice is 1 day overdue with no chase history | `daysOverdue = 1`. `nextStepDue(1, [])` returns `1`. State machine advances to `stage1_gentle` and creates Stage 1 draft. |
| 11 | State Machine | Invoice is in `stage1_gentle`, but only 6 days have elapsed since Stage 1 chase was sent | `daysSinceChase = 6`. `advanceEscalationStage` returns current stage `stage1_gentle` with `nextAction = "Waiting — 6d since Stage 1 (need 7+)"`. |
| 12 | State Machine | Invoice is in `stage1_gentle`, and exactly 7 days have elapsed since Stage 1 chase was sent | `daysSinceChase = 7`. State machine advances to `stage2_followup` and schedules Stage 2 draft. |
| 13 | State Machine | Invoice is in `stage4_final`, and 7+ days elapse with no payment | State machine issues recommendation: "No payment after final notice — consider handing back to client" and transitions to terminal `handed_back`. |
| 14 | State Machine | Invoice has status `paid` in database, but cron triggers overdue detection | Overdue query explicitly filters `WHERE i.status = 'overdue'`; paid invoices are never evaluated, and no chase drafts are ever generated. |
| 15 | State Machine | Debtor pays while draft is sitting unapproved in `/admin` review queue | Provider webhook or operator marks invoice `paid`. When operator opens `/admin` or clicks approve, handler checks invoice status and rejects sending with error "Invoice already settled". |
| 16 | Statutory Calculation | Invoice amount is exactly £999.99 (99,999 pence) | `fixedCompensationPence(99_999)` returns `4000` (£40.00). |
| 17 | Statutory Calculation | Invoice amount is exactly £1,000.00 (100,000 pence) | `fixedCompensationPence(100_000)` returns `7000` (£70.00). |
| 18 | Statutory Calculation | Invoice amount is exactly £9,999.99 (999,999 pence) | `fixedCompensationPence(999_999)` returns `7000` (£70.00). |
| 19 | Statutory Calculation | Invoice amount is exactly £10,000.00 (1,000,000 pence) | `fixedCompensationPence(1_000_000)` returns `10000` (£100.00). |
| 20 | Statutory Calculation | Debt overdue for 0 days | `statutoryInterestPence(100_000, 0, 3.75)` returns `0` pence. |
| 21 | Statutory Calculation | Debt of £1,000 (100,000 pence) overdue for 365 days at 3.75% BoE rate (11.75% total) | `statutoryInterestPence(100_000, 365, 3.75)` calculates `((100000 * 11.75) / 100 / 365) * 365 = 11750` pence (£117.50). Exactly 0.00p drift. |
| 22 | Statutory Calculation | Daily rounding drift prevention: £5,000 overdue for 30 days | Daily unrounded rate = `4828.767...` pence. One-time `Math.round` returns `4829` pence. Summing daily rounded pence would drift by several pence over time. |
| 23 | Email Routing | Submitting an operator alert via `SEND` binding | Prohibited by architectural design: operator alerts MUST use `NOTIFY` binding to prevent leaking transactional quotas and enforce recipient restriction. |
| 24 | Email Routing | Debtor email address rejected or bounced | Recorded in `chase_log.outcome = 'bounced'`; status flagged in client portal; subsequent automatic attempts halted until email corrected. |

---

## 4. Deep-Dive Specification for R1: Multi-Tenant Architecture & Accounting Synchronization

### 4.1 Multi-Tenant Data Isolation Constraints

```
+-------------------------------------------------------------------------+
|                               TENANT BOUNDARY                           |
|                                                                         |
|   +-----------------------------------------------------------------+   |
|   |                            CLIENTS                              |   |
|   |   id (PK) | company_name | contact_email | status | plan ...    |   |
|   +-----------------------------------------------------------------+   |
|            |                                              |             |
|            | 1:N                                          | 1:N         |
|            v                                              v             |
|   +--------------------------+       +------------------------------+   |
|   |         INVOICES         |       |    ACCOUNTING_CONNECTIONS    |   |
|   |  id (PK)                 |       |  id (PK)                     |   |
|   |  client_id (FK)          |       |  client_id (FK)              |   |
|   |  invoice_number          |       |  provider ('xero'|'qb')      |   |
|   |  UNIQUE(client_id,       |       |  UNIQUE(client_id, provider) |   |
|   |         invoice_number)  |       |  access_token_encrypted      |   |
|   +--------------------------+       |  refresh_token_encrypted     |   |
|            |                         +------------------------------+   |
|            | 1:N                                                        |
|            v                                                            |
|   +--------------------------+                                          |
|   |        CHASE_LOG         |                                          |
|   |  id (PK)                 |                                          |
|   |  invoice_id (FK)         |                                          |
|   +--------------------------+                                          |
+-------------------------------------------------------------------------+
```

#### Invariant Rules:
1. **Tenant Identification**: Every tenant is identified by a primary key `clients.id`.
2. **Strict Foreign Key Hierarchy**:
   - `invoices.client_id` REFERENCES `clients(id)` ON DELETE RESTRICT.
   - `chase_log.invoice_id` REFERENCES `invoices(id)` ON DELETE CASCADE.
   - `accounting_connections.client_id` REFERENCES `clients(id)` ON DELETE CASCADE.
3. **Collision Resistance**:
   - SQLite table constraint: `UNIQUE (client_id, invoice_number)` guarantees that different clients can manage the same invoice number (e.g. `INV-001`) without collisions, while preventing a single client from having duplicate records.
   - Index constraint: `UNIQUE (client_id, provider)` in `accounting_connections` guarantees at most one active integration per provider per client.
4. **Session Scoping in Edge Workers**:
   - The client portal session cookie (`portal_session`) decrypts to a payload containing the authenticated `clientId`.
   - All client queries must strictly bind `WHERE client_id = ?1` using the session's verified `clientId`.
   - Never allow `clientId` to be passed as an untrusted URL parameter or body payload on client routes.

---

### 4.2 OAuth 2.0 Connection Lifecycle (Xero & QuickBooks)

#### OAuth Flow Parameters:

| Parameter | Xero Specification | QuickBooks (Intuit) Specification |
|---|---|---|
| **Protocol** | OAuth 2.0 Authorization Code + PKCE | OAuth 2.0 Authorization Code |
| **Auth Endpoint** | `https://login.xero.com/identity/connect/authorize` | `https://appcenter.intuit.com/connect/oauth2` |
| **Token Endpoint** | `https://identity.xero.com/connect/token` | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` |
| **Required Scopes** | `offline_access`, `accounting.transactions`, `accounting.contacts.read`, `accounting.settings.read` | `com.intuit.quickbooks.accounting` |
| **Access Token Lifetime** | 30 minutes (1,800 seconds) | 60 minutes (3,600 seconds) |
| **Refresh Token Lifetime** | 60 days (rolling refresh) | 100 days (rolling refresh) |
| **Tenant Identifier** | `tenant_id` (retrieved from `https://api.xero.com/connections`) | `realmId` (passed as query param in redirect callback) |

#### Lifecycle State Transitions:
- `active`: Valid token pair stored, refresh succeeds.
- `expired`: Refresh failed due to network error or temporary service failure. Next sync job attempts refresh.
- `revoked`: Provider returns `invalid_grant` (user revoked app in Xero/QuickBooks console). Requires operator re-authentication.

---

### 4.3 AES-GCM (256-bit) Web Crypto Token Encryption

Tokens must never be stored in plaintext. In accordance with `0006_accounting_connections_and_external_sync.sql`, tokens are stored in `access_token_encrypted` and `refresh_token_encrypted`.

#### Cryptographic Specification:
- **Cipher**: `AES-GCM` (NIST SP 800-38D).
- **Key Length**: 256 bits (32 bytes).
- **Key Derivation**: SHA-256 digest of `env.ACCOUNTING_ENCRYPTION_SECRET`:
  ```typescript
  const keyMaterial = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secretKey));
  const cryptoKey = await crypto.subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  ```
- **IV (Initialization Vector)**: Exactly 12 bytes (96 bits) generated cryptographically random per encryption operation:
  ```typescript
  const iv = crypto.getRandomValues(new Uint8Array(12));
  ```
- **Authentication Tag**: 128 bits (16 bytes), appended automatically by Web Crypto.
- **Wire Format (Stored in DB)**: Base64 string of `[12-byte IV] || [Ciphertext with Auth Tag]`.
- **Decryption Integrity**: Decryption verifies the 16-byte authentication tag. Any tampering, byte corruption, or truncation causes `crypto.subtle.decrypt` to reject the payload and throw an exception.

---

### 4.4 Cryptographic Webhook HMAC Signature Verification

#### QuickBooks Verification:
- **Header**: `intuit-signature`
- **Algorithm**: HMAC-SHA256
- **Secret**: `verifierToken` (configured in Intuit Developer portal)
- **Format**: Base64-encoded digest
- **Timing-Safe Comparison**:
  $$\text{timingSafeEqual}(a, b) = \left( \text{length}(a) == \text{length}(b) \right) \land \left( \sum_{i} (a_i \oplus b_i) == 0 \right)$$

#### Xero Verification:
- **Header**: `x-xero-signature`
- **Algorithm**: HMAC-SHA256
- **Secret**: `webhookKey` (configured in Xero Developer portal)
- **Format**: Base64-encoded digest
- **Handshake Rule**: Xero requires responding with HTTP 200 to validation pings with correct signature. Invalid signatures must return HTTP 401.

---

### 4.5 Event Deduplication & Idempotent Invoice Synchronization

#### Webhook Deduplication Algorithm:
```
1. Receive Webhook Request:
   Extract Event ID -> evt_id
2. Query Database:
   SELECT id FROM accounting_webhook_events WHERE id = ?1
3. If Exists:
   Return 200 OK: { ok: true, duplicate: true }
4. If Not Exists:
   BEGIN TRANSACTION;
   INSERT INTO accounting_webhook_events (id, provider, event_type, payload) VALUES (?1, ...);
   Execute sync logic;
   COMMIT;
   Return 200 OK: { ok: true }
```

#### Idempotent Invoice Reconciliation Rules:
1. When syncing an invoice:
   - Identify record via `external_id = :provider_invoice_id AND client_id = :client_id`.
2. If record exists:
   - If provider status is `PAID`:
     - Set `status = 'paid'`, `paid_date = date('now')`, `last_synced_at = datetime('now')`.
     - Halt all pending drafts in `chase_log` (`UPDATE chase_log SET status = 'skipped' WHERE invoice_id = :id AND status = 'draft'`).
   - If provider status is `VOIDED` or `DELETED`:
     - Set `status = 'disputed'`, halt pending drafts.
   - If provider amount or due date changed:
     - Update `amount_pence`, `due_date`, `last_synced_at`.
3. If record does not exist:
   - If status in provider is unpaid and overdue:
     - Insert new invoice with `status = 'overdue'`, `external_id = :provider_invoice_id`.
   - If status in provider is already paid:
     - Insert as historical record with `status = 'paid'`.

---

## 5. Deep-Dive Specification for R2: Credit-Control Escalation & Statutory Calculation Engine

### 5.1 4-Stage Escalation State Machine Specification

```
                     +----------------------------------+
                     |         Invoice Created          |
                     |         (status: 'new')          |
                     +----------------------------------+
                                      |
                                      | daysOverdue >= 1
                                      v
+---------------------------------------------------------------------------------+
| STAGE 1: Gentle Reminder                                                        |
| Trigger: 1+ days overdue                                                        |
| Focus: Light, friendly notification; assumption it slipped through              |
| Statutory Notice: NONE                                                          |
+---------------------------------------------------------------------------------+
                                      |
                                      | daysSinceChase >= 7 (Day 8+ overdue)
                                      v
+---------------------------------------------------------------------------------+
| STAGE 2: Follow-up Reminder                                                     |
| Trigger: 7+ days after Stage 1                                                  |
| Focus: Courteous check-in; asking for payment date or dispute details           |
| Statutory Notice: NONE                                                          |
+---------------------------------------------------------------------------------+
                                      |
                                      | daysSinceChase >= 7 (Day 15+ overdue)
                                      v
+---------------------------------------------------------------------------------+
| STAGE 3: Firm Notice                                                            |
| Trigger: 7+ days after Stage 2                                                  |
| Focus: Firm demand citing agreed credit terms                                   |
| Statutory Notice: MANDATORY (BoE+8% daily interest + statutory late fee)        |
+---------------------------------------------------------------------------------+
                                      |
                                      | daysSinceChase >= 7 (Day 22+ overdue)
                                      v
+---------------------------------------------------------------------------------+
| STAGE 4: Final Demand                                                           |
| Trigger: 7+ days after Stage 3                                                  |
| Focus: Formal 7-day hand-back notice prior to external recovery/legal action    |
| Statutory Notice: MANDATORY (accrued interest updated to current date)          |
+---------------------------------------------------------------------------------+
                                      |
                                      | daysSinceChase >= 7 (Day 29+ overdue)
                                      v
+---------------------------------------------------------------------------------+
| TERMINAL STATE: Handed Back / Escalated                                         |
| Action: No further automated chasing. Matter returned to client.                |
+---------------------------------------------------------------------------------+
```

#### Terminal States:
1. `paid`: Invoice is fully paid. No further chases are scheduled or sent.
2. `handed_back`: Sequence completed after Stage 4. Invoice status updated to `escalated` or `handed_back`. Operator notified to deliver final file to client.

---

### 5.2 Statutory Calculation Engine

#### Governing Legislation:
- **Primary Legislation**: Late Payment of Commercial Debts (Interest) Act 1998 (c. 20).
- **Secondary Legislation**: Late Payment of Commercial Debts Regulations 2002 (SI 2002/1674) and Late Payment of Commercial Debts Regulations 2013 (SI 2013/395).

#### 1. Statutory Interest Rate:
$$\text{Statutory Annual Rate (\%)} = \text{BoE Base Rate (\%)} + 8.00\%$$
- Example: If Bank of England Official Bank Rate = $3.75\%$, the statutory annual interest rate is:
  $$3.75\% + 8.00\% = 11.75\%$$

#### 2. Exact Mathematical Interest Formula (Zero Rounding Drift):
$$\text{InterestPence} = \text{round}\left( \frac{\text{AmountPence} \times (\text{BaseRate} + 8) \times \text{DaysOverdue}}{100 \times 365} \right)$$

*Implementation Rule (No Accumulation Drift)*:
Do not calculate a daily interest amount in pence and add it incrementally each day (e.g. `prev + round(daily)`), as rounding fractions of a penny daily introduces drift of several pence over 30–90 days. Always calculate the total accrued interest directly from the original principal and total `daysOverdue` in a single evaluation.

#### 3. Statutory Compensation Fee Tiers:
Under Section 5A of the 1998 Act (inserted by 2002 Regulations and confirmed by 2013 Regulations):

| Principal Debt (£) | Principal Debt (Pence) | Statutory Fee (£) | Statutory Fee (Pence) |
|---|---|---|---|
| **Under £1,000.00** | $0 \le \text{pence} < 100,000$ | **£40.00** | `4000` |
| **£1,000.00 to £9,999.99** | $100,000 \le \text{pence} < 1,000,000$ | **£70.00** | `7000` |
| **£10,000.00 and above** | $\text{pence} \ge 1,000,000$ | **£100.00** | `10000` |

---

### 5.3 Locked Sender Constraints & Legal Guardrails

#### Sender Identity:
- Envelope `FROM`: `hello@invoicerescue.co.uk`
- Display Name: `Invoice Rescue`
- Outbound Mail Server: Authenticated Cloudflare Email Sending with DKIM alignment to `google._domainkey` and SPF `include:_spf.google.com include:_spf.mx.cloudflare.net`.

#### Mandatory Sign-off Block (Exact Verbatim):
```text
Tibor Rames
Invoice Rescue — acting on behalf of [Client Business Name]
hello@invoicerescue.co.uk
```

#### Legal & Ethical Constraints:
1. **Factual Integrity**: No false assertions of legal proceedings, bailiff actions, or CCJs.
2. **No Invented Fees**: Never add administrative charges, collection fees, or non-statutory charges. Only the statutory interest and fixed compensation fee defined above are permissible.
3. **PECR & Regulatory Posture**:
   - Invoice Rescue is not a debt collection agency and is not FCA-regulated.
   - Communications are strictly commercial B2B credit-control acting as the authorized agent of the creditor.
4. **Immediate Cease-and-Desist**:
   - If an invoice is marked as `paid` or `disputed`, all drafting and sending stops immediately.

---

### 5.4 Deliverability Split-Trust Email Routing

To protect IP reputation and isolate failure domains, the Cloudflare Worker architecture enforces two distinct email bindings:

```
                          Cloudflare Worker
                                  |
         +------------------------+------------------------+
         |                                                 |
         v                                                 v
  NOTIFY Binding                                     SEND Binding
  (Restricted Trust)                                 (Public Transactional)
         |                                                 |
         v                                                 v
  Operator Destination                              External Recipients
  (tiborcc2@gmail.com)                              - Debtor Inboxes (Chase messages)
  - Lead alerts                                     - Client Inboxes (Friday reports)
  - Review queue digests                            - Client Auth (Magic links)
  - Payment failure alerts
```

1. **`NOTIFY` Binding**:
   - Configured in `wrangler.jsonc` with `destination_address = "tiborcc2@gmail.com"`.
   - Cannot be hijacked by external injection to send spam to third parties.
2. **`SEND` Binding**:
   - Configured without destination address restrictions.
   - Used only for debtor communications (which MUST pass human review in `/admin`), weekly reports, and magic links.
   - Enforces human-in-the-loop: Every single chase draft generated by the automated cron detection is created with `status = 'draft'` in `chase_log`. No debtor email is ever sent autonomously; the operator must explicitly click "Approve & Send".

---

## 6. Verification & Compliance Matrix

| Requirement | Target Verification Method | Expected Result |
|---|---|---|
| **Multi-Tenant Isolation** | SQL foreign key checks & scoped query inspection | Zero cross-tenant data leakage |
| **AES-GCM Encryption** | `tests/oauth.test.ts` | 256-bit ciphertext, successfully round-tripped with auth tag verification |
| **HMAC Signatures** | `tests/webhooks.test.ts` | Valid HMAC matches; tampered payload rejected |
| **Webhook Idempotency** | Duplicate event injection test | First call processes; second call returns `{ ok: true, duplicate: true }` |
| **Escalation Cadence** | `tests/escalation.test.ts` | Steps trigger at [1, 8, 15, 22] days overdue |
| **Terminal States** | State machine termination test | `paid` and `handed_back` produce no further chases |
| **Statutory Interest** | `tests/statutory-interest.test.ts` | Accrues at BoE+8% with zero daily rounding drift |
| **Statutory Fees** | `tests/statutory-interest.test.ts` | £40 (<£1k), £70 (£1k-£10k), £100 (>=£10k) |
| **Locked Sender** | `tests/gemini.test.ts` | Verbatim `Tibor Rames \n Invoice Rescue — acting on behalf of...` sign-off |
| **Type Integrity** | `npx tsc --noEmit` | 0 errors |
| **Unit Test Suite** | `npm test` (`tsx --test tests/**/*.test.ts`) | 31/31 passing |
