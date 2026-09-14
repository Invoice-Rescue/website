# SaaS Reliability Standards & Engineering Rules

This document governs architecture, data integrity, security boundaries, and runtime reliability for **Invoice Rescue** as a commercial B2B SaaS application.

---

## 1. Idempotency & Safe Retries

- **Webhook Ingestion**: All webhook consumers (e.g. `/api/billing/webhook` for Stripe) must be strictly idempotent. Handle re-delivered events without corrupting database state or creating duplicate records.
- **Background Cron Triggers**: Scheduled handlers (`detect-overdue`, `friday-report`) must verify current invoice and chase status before executing operations. Never assume a cron trigger runs exactly once; handle duplicate or delayed triggers safely.
- **Client Retries**: Critical client mutations should support idempotent replays.

---

## 2. Fail-Closed Security & Boundary Validation

- **Zero Unverified Access**: Gated endpoints (`/admin`, `/api/clients`, `/api/chase/*`) must fail closed. If authentication credentials or signing secrets (`ADMIN_SECRET`, `PORTAL_SESSION_SECRET`, `STRIPE_WEBHOOK_SECRET`) are missing or unconfigured, the endpoint must immediately reject the request with appropriate 401/400 status codes.
- **Input Parsing at the Edge**: External inputs (form POSTs, webhook JSON payloads, CSV imports, query parameters) must be validated before passing into domain logic.
- **Parameterized SQL**: All database interactions with Cloudflare D1 must use prepared statements with parameter binding (`?` placeholders). Concatenating input into SQL strings is strictly prohibited.

---

## 3. Database Atomicity & Schema Evolution

- **Batch Operations**: When a business transaction touches multiple tables or updates interrelated records (e.g., recording a chase event and updating invoice status), wrap the statements in `env.DB.batch([stmt1, stmt2])` to execute them atomically in a single round-trip.
- **Zero-Downtime Migrations**:
  - Migrations in `backend/db/migrations/` must be backward-compatible with running Worker instances.
  - Adding non-nullable columns must provide default values.
  - Never execute manual destructive changes in production without testing locally via `wrangler d1 migrations apply invoice-rescue-db --local`.

---

## 4. Observability & Defensive Error Handling

- **Error Sanitization**: Never leak raw database errors, stack traces, or internal server tokens to client HTTP responses. Return structured, actionable error codes (`{"error": "invalid_request", "code": 400}`).
- **Health Check Contract**: `/api/health` must remain public, fast (<50ms), and lightweight. It verifies that the Worker runtime is healthy and can reach core bindings without disclosing sensitive internal infrastructure metadata.
- **Logging with Context**: Always include request path, HTTP method, client ID (if authenticated), and sanitized error descriptions in diagnostic logs. Never log PII (bank details, passwords, raw auth tokens).
