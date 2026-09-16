# M1 Webhooks & Accounting Synchronization Specification & Architectural Design

**Document:** M1 Webhooks & Sync Design Report (R1 & R4)  
**Author:** M1 Webhooks & Sync Explorer  
**Status:** Authoritative Architectural Design  
**Date:** 2026-09-16  
**Target Environment:** Cloudflare Workers (Edge Runtime `2026-07-15`, `nodejs_compat`), Cloudflare D1 SQLite, Web Crypto API  

---

## 1. Executive Summary

Milestone M1 (R1: Multi-Tenant Data Architecture & Accounting Synchronization) requires:
1. Cryptographic webhook verification and ingestion for **Xero** (`x-xero-signature`) and **QuickBooks** (`intuit-signature`).
2. Robust support for the **Xero Intent to Receive (ITR)** validation handshake (returning HTTP 401 on tampered signatures, HTTP 200 on valid requests).
3. Replay-attack and duplicate-event defense via deduplication in `accounting_webhook_events`.
4. An idempotent **`SyncService`** in `backend/src/lib/integrations/sync-service.ts` that decrypts OAuth tokens, handles automatic token rotation, fetches invoices via zero-dependency HTTP `fetch()`, upserts debtor records into D1 `invoices`, and immediately halts automated chasing on paid invoices.
5. A daily cron scheduled integration in `backend/src/index.ts` that runs accounting synchronization **prior to** overdue escalation detection to guarantee zero chase drafts are staged for already-settled accounts.

This report delivers the complete architectural design, cryptographic protocols, SQL mutations, and production-ready TypeScript code blueprints for implementers.

---

## 2. Baseline Codebase Inventory & Gap Analysis

### 2.1 Existing Assets
- **`backend/src/lib/integrations/webhooks.ts`**:
  - `verifyQuickBooksWebhook(payload, signatureHeader, verifierToken)`: Computes HMAC-SHA256, converts to Base64, verifies with `timingSafeEqual`.
  - `verifyXeroWebhook(payload, signatureHeader, webhookKey)`: Computes HMAC-SHA256, converts to Base64, verifies with `timingSafeEqual`.
  - `timingSafeEqual(a, b)`: Constant-time string comparison preventing timing side-channel attacks.
  - Basic parsers: `parseQuickBooksInvoiceUpdate`, `parseXeroInvoiceUpdate`.
  - Covered by `tests/webhooks.test.ts` (passing 31/31 suite).
- **`backend/src/lib/integrations/oauth-manager.ts`**:
  - `encryptToken(plaintext, secretKey)`: AES-GCM 256-bit encryption with random 12-byte IV.
  - `decryptToken(ciphertextWithIv, secretKey)`: Extracts 12-byte IV, verifies authentication tag, returns plaintext.
  - Covered by `tests/oauth.test.ts`.
- **`backend/db/migrations/0006_accounting_connections_and_external_sync.sql`**:
  - Table `accounting_connections`:
    - Columns: `id`, `client_id`, `provider`, `tenant_id`, `access_token_encrypted`, `refresh_token_encrypted`, `expires_at`, `last_synced_at`, `status`, `created_at`.
    - Index: `UNIQUE (client_id, provider)`.
  - Table `accounting_webhook_events`:
    - Columns: `id` (PRIMARY KEY), `provider`, `event_type`, `payload`, `processed_at`.

### 2.2 Critical Gaps Identified
1. **Unmounted Webhook Routes**:
   - `backend/src/index.ts` has no handlers for `POST /api/webhooks/xero` or `POST /api/webhooks/quickbooks`.
2. **Missing Xero ITR Handshake Handling**:
   - Xero sends an ITR probe with an invalid signature first (expects HTTP 401), followed by a probe with a valid signature (expects HTTP 200). The route must return HTTP 401 specifically when verification fails.
3. **Missing Event Deduplication Pipeline**:
   - Webhook events are neither recorded nor checked against `accounting_webhook_events`.
4. **Stubbed SyncService**:
   - `backend/src/lib/integrations/sync-service.ts` is a 6-line dummy class returning `{ success: true }`.
5. **No Daily Accounting Polling in Cron**:
   - `scheduled()` in `backend/src/index.ts` triggers `runOverdueDetection(env)` at `06:00 UTC` without first syncing accounting records.

---

## 3. Cryptographic Webhook Handlers Design

```
                     Incoming Webhook Request
                                |
               +----------------+----------------+
               |                                 |
       POST /api/webhooks/xero         POST /api/webhooks/quickbooks
               |                                 |
      Extract Header:                   Extract Header:
      x-xero-signature                  intuit-signature
               |                                 |
      Web Crypto HMAC-SHA256            Web Crypto HMAC-SHA256
      Secret: XERO_WEBHOOK_KEY          Secret: QUICKBOOKS_VERIFIER_TOKEN
               |                                 |
      timingSafeEqual()                 timingSafeEqual()
               |                                 |
        +------+------+                   +------+------+
        |             |                   |             |
     Invalid        Valid              Invalid        Valid
        |             |                   |             |
     HTTP 401      HTTP 200            HTTP 401      HTTP 200
  (Mandatory ITR)     |                                 |
                      v                                 v
         Extract event batch:              Extract event batch:
         events[]                          eventNotifications[].entities[]
                      |                                 |
                      +----------------+----------------+
                                       |
                                       v
                     Synthesize Deterministic Event ID
                     (e.g., xero_${tenantId}_${resId}_${type}_${date})
                                       |
                                       v
                    Deduplication: Check DB Primary Key
                    SELECT id FROM accounting_webhook_events
                                       |
                     +-----------------+-----------------+
                     |                                   |
                  Exists?                             Exists?
                   YES                                  NO
                     |                                   |
              Return Duplicate                    Insert Event Row
              (HTTP 200, skipped)                 Execute SyncService
                                                  (Update/Mark Paid)
```

### 3.1 Xero Webhook Handler (`POST /api/webhooks/xero`)

#### A. Cryptographic & ITR Validation
- **Header**: `x-xero-signature`
- **Algorithm**: HMAC-SHA256 of the raw payload string, Base64-encoded.
- **ITR Requirement**:
  - When configuring a webhook in the Xero Developer Portal, Xero sends two test requests:
    1. A request with an **invalid signature**; Invoice Rescue **must** respond with **HTTP 401 Unauthorized**.
    2. A request with a **valid signature**; Invoice Rescue **must** respond with **HTTP 200 OK**.
  - Any non-401 response for invalid signatures causes Xero's ITR handshake to fail.

#### B. Payload Structure
```json
{
  "events": [
    {
      "resourceUrl": "https://api.xero.com/api.xro/2.0/Invoices/663c2306-6469-42b7-a36c-941d6b052b65",
      "resourceId": "663c2306-6469-42b7-a36c-941d6b052b65",
      "eventDateUtc": "2026-09-16T05:00:00.000Z",
      "eventType": "UPDATE",
      "eventCategory": "INVOICE",
      "tenantId": "9b12a87a-a4be-4cc5-a89e-ec8e390c96c4",
      "tenantType": "ORGANISATION"
    }
  ],
  "firstEventSequence": 1,
  "lastEventSequence": 1,
  "entropy": "XYZ..."
}
```

#### C. Deduplication Strategy
- Individual events within `events[]` are processed.
- Deterministic event ID:
  ```typescript
  const eventId = `xero_${event.tenantId}_${event.resourceId}_${event.eventType}_${event.eventDateUtc}`;
  ```
- Check `accounting_webhook_events` for `eventId`. If present, skip.
- If absent, insert `(id, provider, event_type, payload)` into `accounting_webhook_events`.

#### D. Handler Implementation
```typescript
export async function handleXeroWebhook(request: Request, env: Env): Promise<Response> {
  const webhookKey = (env as Record<string, any>).XERO_WEBHOOK_KEY;
  if (!webhookKey) {
    console.error("XERO_WEBHOOK_KEY secret is not configured");
    return new Response("Configuration error", { status: 500, headers: SECURITY_HEADERS });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-xero-signature");

  // Xero ITR Handshake check: MUST return 401 on invalid signature
  const isValid = await verifyXeroWebhook(rawBody, signature || "", webhookKey);
  if (!isValid) {
    return new Response("Unauthorized", { status: 401, headers: SECURITY_HEADERS });
  }

  // Handle empty ITR ping
  if (!rawBody || rawBody.trim() === "") {
    return new Response(null, { status: 200, headers: SECURITY_HEADERS });
  }

  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 200, headers: SECURITY_HEADERS });
  }

  const events = data.events ?? [];
  if (events.length === 0) {
    return new Response(null, { status: 200, headers: SECURITY_HEADERS });
  }

  const syncService = new SyncService(env.DB, env);

  for (const ev of events) {
    if (ev.eventCategory !== "INVOICE") continue;

    const eventId = `xero_${ev.tenantId}_${ev.resourceId}_${ev.eventType}_${ev.eventDateUtc}`;
    
    // Deduplication check
    const existing = await env.DB.prepare(
      "SELECT id FROM accounting_webhook_events WHERE id = ?1"
    ).bind(eventId).first();

    if (existing) {
      continue; // Skip duplicate event
    }

    // Record webhook event
    await env.DB.prepare(
      "INSERT INTO accounting_webhook_events (id, provider, event_type, payload, processed_at) VALUES (?1, 'xero', ?2, ?3, datetime('now'))"
    ).bind(eventId, ev.eventType, JSON.stringify(ev)).run();

    // Map tenantId to client_id
    const conn = await env.DB.prepare(
      "SELECT client_id FROM accounting_connections WHERE provider = 'xero' AND tenant_id = ?1 AND status = 'active'"
    ).bind(ev.tenantId).first<{ client_id: number }>();

    if (conn) {
      await syncService.syncSingleInvoice(conn.client_id, "xero", ev.resourceId);
    }
  }

  return Response.json({ ok: true }, { status: 200, headers: SECURITY_HEADERS });
}
```

---

### 3.2 QuickBooks Webhook Handler (`POST /api/webhooks/quickbooks`)

#### A. Cryptographic Validation
- **Header**: `intuit-signature`
- **Algorithm**: HMAC-SHA256 of raw request payload, Base64-encoded.
- **Secret**: `env.QUICKBOOKS_VERIFIER_TOKEN`
- **Validation**: Fails closed if header is missing, token is empty, or `timingSafeEqual` returns false.

#### B. Payload Structure
```json
{
  "eventNotifications": [
    {
      "realmId": "1234567890",
      "dataChangeEvent": {
        "entities": [
          {
            "name": "Invoice",
            "id": "145",
            "operation": "Update",
            "lastUpdated": "2026-09-16T05:00:00.000Z"
          }
        ]
      }
    }
  ]
}
```

#### C. Deduplication Strategy
- Deterministic event ID:
  ```typescript
  const eventId = `qb_${realmId}_${entity.name}_${entity.id}_${entity.operation}_${entity.lastUpdated}`;
  ```
- Checked against `accounting_webhook_events` primary key.

#### D. Handler Implementation
```typescript
export async function handleQuickBooksWebhook(request: Request, env: Env): Promise<Response> {
  const verifierToken = (env as Record<string, any>).QUICKBOOKS_VERIFIER_TOKEN;
  if (!verifierToken) {
    console.error("QUICKBOOKS_VERIFIER_TOKEN secret is not configured");
    return new Response("Configuration error", { status: 500, headers: SECURITY_HEADERS });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("intuit-signature");

  const isValid = await verifyQuickBooksWebhook(rawBody, signature || "", verifierToken);
  if (!isValid) {
    return Response.json({ ok: false, error: "Invalid signature" }, { status: 401, headers: SECURITY_HEADERS });
  }

  let data: any;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
  }

  const syncService = new SyncService(env.DB, env);

  for (const notification of data.eventNotifications ?? []) {
    const realmId = notification.realmId;
    const entities = notification.dataChangeEvent?.entities ?? [];

    for (const entity of entities) {
      if (entity.name !== "Invoice") continue;

      const eventId = `qb_${realmId}_${entity.name}_${entity.id}_${entity.operation}_${entity.lastUpdated}`;

      // Deduplication check
      const existing = await env.DB.prepare(
        "SELECT id FROM accounting_webhook_events WHERE id = ?1"
      ).bind(eventId).first();

      if (existing) {
        continue;
      }

      // Record event
      await env.DB.prepare(
        "INSERT INTO accounting_webhook_events (id, provider, event_type, payload, processed_at) VALUES (?1, 'quickbooks', ?2, ?3, datetime('now'))"
      ).bind(eventId, entity.operation, JSON.stringify(entity)).run();

      // Map realmId to client_id
      const conn = await env.DB.prepare(
        "SELECT client_id FROM accounting_connections WHERE provider = 'quickbooks' AND tenant_id = ?1 AND status = 'active'"
      ).bind(realmId).first<{ client_id: number }>();

      if (conn) {
        await syncService.syncSingleInvoice(conn.client_id, "quickbooks", entity.id);
      }
    }
  }

  return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
}
```

---

## 4. `SyncService` Implementation Design (`backend/src/lib/integrations/sync-service.ts`)

### 4.1 Normalized Invoice Model
```typescript
export interface NormalizedInvoice {
  externalId: string;
  invoiceNumber: string;
  debtorName: string;
  debtorEmail: string | null;
  amountPence: number;
  currency: string;
  dueDate: string; // YYYY-MM-DD
  issuedDate: string | null; // YYYY-MM-DD
  isPaid: boolean;
  paidDate: string | null; // YYYY-MM-DD
  isDisputedOrVoid: boolean;
}

export interface SyncResult {
  success: boolean;
  provider: "xero" | "quickbooks";
  clientId: number;
  invoicesSynced: number;
  invoicesCreated: number;
  invoicesUpdated: number;
  invoicesMarkedPaid: number;
  errors?: string[];
}
```

### 4.2 OAuth Token Decryption & Rolling Refresh Engine
1. **Decryption**:
   - Decrypt `access_token_encrypted` and `refresh_token_encrypted` via `decryptToken(cipher, env.TOKEN_ENCRYPTION_SECRET)`.
2. **Refresh Check**:
   - If `Date.now() >= new Date(connection.expires_at).getTime() - 5 * 60 * 1000` (within 5 minutes of expiry):
   - **Xero Refresh**:
     ```typescript
     const res = await fetch("https://identity.xero.com/connect/token", {
       method: "POST",
       headers: {
         "Content-Type": "application/x-www-form-urlencoded",
         "Authorization": `Basic ${btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`)}`,
       },
       body: new URLSearchParams({
         grant_type: "refresh_token",
         refresh_token: decryptedRefreshToken,
       }),
     });
     ```
   - **QuickBooks Refresh**:
     ```typescript
     const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
       method: "POST",
       headers: {
         "Content-Type": "application/x-www-form-urlencoded",
         "Authorization": `Basic ${btoa(`${env.QUICKBOOKS_CLIENT_ID}:${env.QUICKBOOKS_CLIENT_SECRET}`)}`,
       },
       body: new URLSearchParams({
         grant_type: "refresh_token",
         refresh_token: decryptedRefreshToken,
       }),
     });
     ```
   - **Revocation Handling**:
     - If response status is 400 or payload has `invalid_grant`, update D1:
       `UPDATE accounting_connections SET status = 'revoked' WHERE id = ?1`
     - Halt sync and log warning.
   - **Storage Update**:
     - Re-encrypt new access and refresh tokens via `encryptToken`.
     - Update `accounting_connections`: `access_token_encrypted`, `refresh_token_encrypted`, `expires_at`, `status = 'active'`.

### 4.3 Provider Fetch & Ingestion

#### A. Xero API Integration
- **Full Invoices Fetch**:
  ```typescript
  const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED,PAID", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      "Accept": "application/json",
    },
  });
  ```
- **Single Invoice Fetch**:
  `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`
- **Normalization Mapping**:
  - `amountPence = Math.round((inv.AmountDue ?? inv.Total) * 100)`
  - `isPaid = inv.Status === "PAID" || (inv.AmountDue !== undefined && inv.AmountDue <= 0)`
  - `isDisputedOrVoid = inv.Status === "VOIDED" || inv.Status === "DELETED"`
  - `dueDate = parseDate(inv.DueDateString || inv.DueDate)`

#### B. QuickBooks API Integration
- **Full Invoices Fetch**:
  ```typescript
  const query = encodeURIComponent("SELECT * FROM Invoice MAXRESULTS 1000");
  const res = await fetch(`https://quickbooks.api.intuit.com/v3/company/${tenantId}/query?query=${query}`, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
  });
  ```
- **Single Invoice Fetch**:
  `https://quickbooks.api.intuit.com/v3/company/${tenantId}/invoice/${invoiceId}`
- **Normalization Mapping**:
  - `amountPence = Math.round((inv.Balance ?? inv.TotalAmt) * 100)`
  - `isPaid = inv.Balance !== undefined && inv.Balance <= 0`
  - `isDisputedOrVoid = inv.status === "Deleted"`
  - `dueDate = inv.DueDate`

### 4.4 Idempotent Reconciliation & Draft Halting Rules

The core business and legal invariant of Invoice Rescue is that **a debtor must never receive a chase message for an invoice that has been settled**.

```typescript
async function reconcileInvoice(
  db: D1Database,
  clientId: number,
  norm: NormalizedInvoice
): Promise<"created" | "updated" | "marked_paid" | "unchanged"> {
  const existing = await db.prepare(
    `SELECT id, invoice_number, amount_pence, status, due_date, paid_date 
     FROM invoices 
     WHERE client_id = ?1 AND invoice_number = ?2`
  ).bind(clientId, norm.invoiceNumber).first<{
    id: number;
    invoice_number: string;
    amount_pence: number;
    status: string;
    due_date: string;
    paid_date: string | null;
  }>();

  if (existing) {
    // 1. Invoice is Settled / Paid
    if (norm.isPaid) {
      if (existing.status !== "paid") {
        await db.batch([
          // Update invoice state
          db.prepare(
            `UPDATE invoices 
             SET status = 'paid', 
                 paid_date = COALESCE(?1, date('now')), 
                 amount_pence = ?2, 
                 external_id = ?3, 
                 last_synced_at = datetime('now') 
             WHERE id = ?4`
          ).bind(norm.paidDate, norm.amountPence, norm.externalId, existing.id),

          // HALT AUTOMATED CHASES: Skip any pending review-queue drafts
          db.prepare(
            `UPDATE chase_log 
             SET status = 'skipped' 
             WHERE invoice_id = ?1 AND status = 'draft'`
          ).bind(existing.id)
        ]);
        return "marked_paid";
      }
      return "unchanged";
    }

    // 2. Invoice is Voided or Disputed in Provider
    if (norm.isDisputedOrVoid) {
      if (existing.status !== "disputed") {
        await db.batch([
          db.prepare(
            `UPDATE invoices 
             SET status = 'disputed', 
                 external_id = ?1, 
                 last_synced_at = datetime('now') 
             WHERE id = ?2`
          ).bind(norm.externalId, existing.id),

          db.prepare(
            `UPDATE chase_log 
             SET status = 'skipped' 
             WHERE invoice_id = ?1 AND status = 'draft'`
          ).bind(existing.id)
        ]);
        return "updated";
      }
      return "unchanged";
    }

    // 3. Invoice remains unpaid - update details if changed
    if (existing.status !== "paid") {
      await db.prepare(
        `UPDATE invoices 
         SET amount_pence = ?1, 
             due_date = ?2, 
             debtor_name = ?3, 
             debtor_email = COALESCE(?4, debtor_email), 
             external_id = ?5, 
             last_synced_at = datetime('now') 
         WHERE id = ?6`
      ).bind(norm.amountPence, norm.dueDate, norm.debtorName, norm.debtorEmail, norm.externalId, existing.id).run();
      return "updated";
    }

    return "unchanged";
  }

  // Invoice does not exist in D1
  if (norm.isPaid) {
    await db.prepare(
      `INSERT INTO invoices 
       (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, paid_date, external_id, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'paid', COALESCE(?9, date('now')), ?10, datetime('now'))`
    ).bind(
      clientId, norm.debtorName, norm.debtorEmail, norm.invoiceNumber, norm.amountPence, norm.currency,
      norm.issuedDate, norm.dueDate, norm.paidDate, norm.externalId
    ).run();
    return "created";
  }

  // Insert active overdue/unpaid record
  await db.prepare(
    `INSERT INTO invoices 
     (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, external_id, last_synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'overdue', ?9, datetime('now'))`
  ).bind(
    clientId, norm.debtorName, norm.debtorEmail, norm.invoiceNumber, norm.amountPence, norm.currency,
    norm.issuedDate, norm.dueDate, norm.externalId
  ).run();

  return "created";
}
```

---

## 5. Daily Scheduled Cron Polling Integration (`backend/src/index.ts`)

### 5.1 Execution Sequencing & Pipeline Safety

In Cloudflare Workers, cron triggers run via the `scheduled()` entry point:
```typescript
async scheduled(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron === "0 6 * * *") {
    // STEP 1: Ingest and reconcile external accounting providers FIRST
    await pollActiveAccountingProviders(env);

    // STEP 2: Run overdue detection and AI drafting on newly reconciled data
    await runOverdueDetection(env);
  } else if (event.cron === "0 8 * * FRI") {
    await runFridayReport(env);
  }
}
```

### 5.2 Provider Polling Implementation (`pollActiveAccountingProviders`)
```typescript
async function pollActiveAccountingProviders(env: Env): Promise<void> {
  // Query all active connections
  const connections = await env.DB.prepare(
    `SELECT c.id, c.client_id, c.provider, c.tenant_id, cl.company_name
     FROM accounting_connections c
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.status = 'active'`
  ).all<{ id: number; client_id: number; provider: 'xero' | 'quickbooks'; tenant_id: string; company_name: string }>();

  if (!connections.results || connections.results.length === 0) {
    return;
  }

  const syncService = new SyncService(env.DB, env);

  for (const conn of connections.results) {
    try {
      const result = await syncService.syncInvoices(conn.client_id);
      if (!result.success && result.errors?.length) {
        console.warn(`Sync warning for client ${conn.client_id} (${conn.company_name}):`, result.errors.join("; "));
      }
    } catch (err) {
      console.error(`Scheduled polling failed for client ${conn.client_id} (${conn.company_name}):`, err);
      // Attempt operator notification if token expired/revoked
      try {
        await env.NOTIFY.send({
          to: env.NOTIFY_TO,
          from: { name: SENDER_NAME, email: env.NOTIFY_FROM },
          subject: `Invoice Rescue: Accounting sync failed for ${conn.company_name}`,
          text: `Scheduled synchronization failed for ${conn.company_name} (${conn.provider}). Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch (notifyErr) {
        console.error("Failed to send operator sync error notification:", notifyErr);
      }
    }
  }
}
```

---

## 6. Environment Bindings & Configuration Requirements

To support cryptographic webhooks, token encryption, and provider synchronization, the following variables and secrets must be configured:

### 6.1 Required Secrets (`wrangler secret put <KEY>`)
| Secret Name | Purpose | Target Milestone |
|---|---|---|
| `TOKEN_ENCRYPTION_SECRET` | 256-bit passphrase for AES-GCM token encryption | M1 |
| `XERO_CLIENT_ID` | Xero Developer App client ID | M1 |
| `XERO_CLIENT_SECRET` | Xero Developer App client secret | M1 |
| `XERO_WEBHOOK_KEY` | Webhook key for `x-xero-signature` HMAC verification | M1 |
| `QUICKBOOKS_CLIENT_ID` | Intuit Developer App client ID | M1 |
| `QUICKBOOKS_CLIENT_SECRET` | Intuit Developer App client secret | M1 |
| `QUICKBOOKS_VERIFIER_TOKEN` | Webhook token for `intuit-signature` HMAC verification | M1 |

### 6.2 TypeScript Environment Declaration (`worker-configuration.d.ts`)
Add to `__BaseEnv_Env`:
```typescript
TOKEN_ENCRYPTION_SECRET?: string;
XERO_CLIENT_ID?: string;
XERO_CLIENT_SECRET?: string;
XERO_WEBHOOK_KEY?: string;
QUICKBOOKS_CLIENT_ID?: string;
QUICKBOOKS_CLIENT_SECRET?: string;
QUICKBOOKS_VERIFIER_TOKEN?: string;
```

---

## 7. Testing & Verification Strategy

### 7.1 Unit & Integration Test Targets

| Test File | Test Cases to Implement | Expected Verification |
|---|---|---|
| `tests/webhooks.test.ts` | 1. Xero valid signature returns `true`<br>2. Xero tampered body returns `false`<br>3. QuickBooks valid signature returns `true`<br>4. QuickBooks tampered body returns `false`<br>5. Xero ITR probe simulation: returns HTTP 401 on bad signature, 200 on good signature | Passing with `tsx --test` |
| `tests/sync-service.test.ts` | 1. Token auto-refresh triggering when expiry < 5 min<br>2. Upsert unpaid invoice creates `invoices` row with `status = 'overdue'`<br>3. Upsert paid invoice flips existing row to `status = 'paid'` and cancels pending `chase_log` drafts (`status = 'skipped'`)<br>4. Composite key `(client_id, invoice_number)` collision prevention | Passing with `tsx --test` |
| `tests/webhook-dedup.test.ts` | 1. Inserting duplicate webhook event ID returns `duplicate: true`<br>2. Subsequent calls produce zero redundant D1 writes | Passing with `tsx --test` |

### 7.2 Verification Protocol
1. **Type Checking**:
   `npx tsc --noEmit` -> 0 errors.
2. **Automated Unit Tests**:
   `npm test` -> 100% passing.
3. **Dry-Run Bundle Check**:
   `npm run build` -> Clean dry-run upload, <50 KiB bundle, zero external dependencies.
4. **D1 Migration State**:
   `npx wrangler d1 migrations apply invoice-rescue-db --local` -> Clean migration state.

---

## 8. Summary of Recommendations for Implementation Team

1. **Mount Webhook Endpoints in `backend/src/index.ts`**:
   Insert routing dispatch for `POST /api/webhooks/xero` and `POST /api/webhooks/quickbooks` immediately before the admin routes.
2. **Strictly Enforce HTTP 401 on Xero Webhook Failures**:
   Ensure invalid signature checks in `handleXeroWebhook` return HTTP 401 (not 400 or 500) to satisfy Xero ITR automated validator.
3. **Upgrade `SyncService`**:
   Replace the 6-line stub in `backend/src/lib/integrations/sync-service.ts` with the complete zero-dependency `SyncService` class containing `syncInvoices()`, `syncSingleInvoice()`, and draft-skipping reconciliation.
4. **Wire Cron Polling**:
   Prepend `pollActiveAccountingProviders(env)` to the `0 6 * * *` branch of `scheduled()`.
