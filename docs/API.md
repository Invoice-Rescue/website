# API Endpoint Reference

This document provides technical documentation for all API routes, background cron handlers, and webhook listeners in Invoice Rescue.

---

## 1. Authentication Mechanisms

The Worker API uses four distinct authentication strategies depending on access level:

1. **Public**: No authentication required. Includes health check, interest rate discovery, and public lead submission.
2. **Client Portal Session**: Passwordless authentication via 15-minute HMAC-signed magic links exchanged for a 7-day HttpOnly session cookie (`portal_session`). No client credential storage.
3. **Operator Admin**: HTTP Basic Authentication (`WWW-Authenticate: Basic`). Any username is accepted; password must match the `ADMIN_SECRET` environment secret.
4. **Stripe Webhook Signature**: Cryptographic HMAC-SHA256 signature verification via the `Stripe-Signature` header and `STRIPE_WEBHOOK_SECRET`.

---

## 2. API Routes Summary

<!-- AUTO-GENERATED:ROUTES_START -->
The following routes are implemented in [`backend/src/index.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/backend/src/index.ts):

| Method | Path | Auth Required | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | Public | Service health check and D1 database connectivity probe. |
| `GET` | `/api/statutory-rate` | Public | Current Bank of England base rate for frontend calculator. |
| `POST` | `/api/lead` | Public | Case review lead submission from landing page. |
| `POST` | `/api/clients` | Admin (Basic Auth) | Onboard new client and provision Stripe customer. |
| `POST` | `/api/clients/:id/invoices/import` | Admin (Basic Auth) | Bulk import invoices for a client from CSV data. |
| `GET` | `/admin` | Admin (Basic Auth) | Server-rendered HTML review queue of drafted chase messages. |
| `POST` | `/api/chase/:id/approve` | Admin (Basic Auth) | Send approved chase email to debtor and record audit trail. |
| `POST` | `/api/chase/:id/skip` | Admin (Basic Auth) | Mark drafted chase message as skipped in review queue. |
| `POST` | `/api/billing/webhook` | Webhook Signature | Process incoming Stripe subscription lifecycle events. |
| `GET` | `/portal` | Public | Render client portal login form or redirect to dashboard. |
| `POST` | `/portal/login` | Public | Dispatch passwordless 15-minute magic login link via email. |
| `GET` | `/portal/verify` | Public | Validate magic link token and establish session cookie. |
| `GET` | `/portal/dashboard` | Client Session | Render client dashboard showing invoices and chase logs. |
| `POST` | `/portal/billing` | Client Session | Create and redirect to Stripe Customer Billing Portal session. |
| `POST` | `/portal/logout` | Client Session | Invalidate session cookie and redirect to login. |
<!-- AUTO-GENERATED:ROUTES_END -->

---

## 3. Route Details

### 3.1 Health & Public Endpoints

#### `GET /api/health`

- **Description**: Probes D1 database connectivity using `SELECT 1`.
- **Response (200 OK)**:

  ```json
  { "ok": true, "service": "invoice-rescue" }
  ```

- **Response (503 Service Unavailable)**:

  ```json
  { "ok": false, "service": "invoice-rescue", "db": "unreachable" }
  ```

#### `GET /api/statutory-rate`

- **Description**: Retrieves current Bank of England base rate percentage.
- **Cache-Control**: `public, max-age=3600`
- **Response (200 OK)**:

  ```json
  { "boeBaseRatePercent": 3.75 }
  ```

#### `POST /api/lead`

- **Description**: Ingests new lead from landing page. Accepts JSON or URL-encoded form data.
- **Body Parameters**:
  - `name` (string, required): Submitter name.
  - `email` (string, required): Valid email address.
  - `company` (string, optional): Company or trading name.
  - `overdue_band` (string, required): One of `under_5k`, `5k_25k`, `25k_100k`, `over_100k`, `not_sure`.
  - `message` (string, optional): Notes on collection history.
  - `website` (string, honeypot): Must be empty. If populated, request silently succeeds without saving.
- **Response (JSON client)**: `200 OK` `{ "ok": true }`
- **Response (Form client)**: `303 See Other` redirect to `/#thanks`

---

### 3.2 Operator Admin Endpoints

All admin endpoints require `Authorization: Basic <credentials>` where password matches `ADMIN_SECRET`.

#### `POST /api/clients`

- **Description**: Registers a new client and creates corresponding Stripe customer.
- **Body (JSON)**:

  ```json
  {
    "company_name": "Acme Studios Ltd",
    "contact_name": "Jane Doe",
    "contact_email": "jane@acmestudios.co.uk",
    "plan": "engine",
    "accounting_source": "csv",
    "voice_notes": "Firm but polite tone; long-standing clients should be reminded gently."
  }
  ```

- **Allowed Plans**: `foundation`, `engine`, `operator`.
- **Allowed Sources**: `xero`, `quickbooks`, `csv`.
- **Response (201 Created)**:

  ```json
  { "ok": true, "id": 42 }
  ```

#### `POST /api/clients/:id/invoices/import`

- **Description**: Ingests CSV invoice file for specified client ID.
- **Expected CSV Headers**: `debtor_name`, `debtor_email`, `invoice_number`, `amount`, `currency`, `issued_date`, `due_date`.
- **Response (200 OK)**:

  ```json
  { "ok": true, "imported": 15, "errors": [] }
  ```

#### `GET /admin`

- **Description**: Renders HTML review queue showing all pending chase message drafts (`status = 'draft'`).

#### `POST /api/chase/:id/approve`

- **Description**: Approves a drafted chase message, dispatches it to debtor email via `SEND` binding, updates status to `sent`, and stamps operator audit trail (`reviewed_by`, `reviewed_at`).
- **Optional Form Field**: `body` (allows operator to edit draft before sending).

#### `POST /api/chase/:id/skip`

- **Description**: Marks a draft as `skipped` in `chase_log`.

---

### 3.3 Client Portal Endpoints

#### `POST /portal/login`

- **Description**: Dispatches a 15-minute magic login link to the provided email if it matches an existing `clients.contact_email`. Always returns success to prevent user enumeration.
- **Body**: `{ "email": "client@example.com" }`

#### `GET /portal/verify?token=...`

- **Description**: Validates HMAC token, issues `Set-Cookie: portal_session=...; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`, and redirects to `/portal/dashboard`.

#### `GET /portal/dashboard`

- **Description**: Renders client portal HTML displaying invoices, payment statuses, and chase communication history with operator review stamps.

#### `POST /portal/billing`

- **Description**: Generates a Stripe Customer Portal session URL and redirects client there to view invoices or update payment methods.

---

### 3.4 Webhook Endpoints

#### `POST /api/billing/webhook`

- **Description**: Handles Stripe subscription lifecycle events with cryptographic signature validation and database-backed idempotency.
- **Idempotency & Sequence Protection**:
  - Each event is recorded in the `webhook_events` table by its Stripe event ID (`evt_...`).
  - Duplicate deliveries return `200 OK` (`{"ok":true,"duplicate":true}`) immediately without executing side effects.
  - Out-of-order events (where a newer subscription event was already processed) are logged and return `200 OK` (`{"ok":true,"skipped_stale":true}`) to avoid regressing client status.
- **Handled Events**:
  - `customer.subscription.updated`: Sets client status to `active` or `paused`.
  - `customer.subscription.deleted`: Sets client status to `churned`.
  - `invoice.payment_failed`: Sends operator notification via email.

---

## 4. Scheduled & Asynchronous Handlers

- **Daily Overdue Detection (`0 6 * * *`)**: Identifies overdue invoices, computes statutory interest and fixed compensation, queries Gemini model to draft personalized debtor messages, stores draft in `chase_log`, and notifies operator.
- **Friday Cash Report (`0 8 * * FRI`)**: Summarizes payments received, promised amounts, and overdue debts for the past 7 days and delivers automated reports to all active clients.
- **Inbound Email Handler (`email`)**: Cloudflare Email Routing hook forwarding inbound correspondence to `INBOX_FORWARD_TO`.
