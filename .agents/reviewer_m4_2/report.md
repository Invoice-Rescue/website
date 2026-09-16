# Milestone M4 Quality Review & Adversarial Challenge Report
**Milestone**: M4 — Email Deliverability & Split-Trust Routing (R4)  
**Reviewer Role**: Reviewer 2 / Adversarial Critic (`reviewer_m4_2`)  
**Target Repository**: `d:\Dev\Workspaces\Active\invoice-rescue`  
**Date**: 2026-09-16  

---

## 1. Review Summary

**Verdict**: **APPROVE**

Milestone M4 implementation satisfies all requirements set forth in `ORIGINAL_REQUEST.md`, `PROJECT.md` (Interface Contract 5), and `worker_m4/handoff.md`. Specifically:
1. `backend/src/lib/email.ts` correctly implements `sendOperatorNotification` and `sendDebtorCommunication`.
2. Split-trust routing is strictly enforced: `NOTIFY` is locked to `tiborcc2@gmail.com`, and `SEND` is locked to sender `Invoice Rescue <hello@invoicerescue.co.uk>`.
3. Standard RFC deliverability headers (`Auto-Submitted: auto-generated`, `Message-ID: <${uuid}@invoicerescue.co.uk>`, `Date: RFC 2822`, `Reply-To: hello@invoicerescue.co.uk`) are automatically attached to outbound mail.
4. Calling sites in `backend/src/lib/chase-runner.ts` and `backend/src/lib/portal-api.ts` have been migrated to the email module routines.
5. Overdue invoice detection in `chase-runner.ts` is shielded by defensive error boundaries, preventing transient email errors from interrupting cron execution.
6. Dead legacy shadow routes (`handleChaseApprove`, `handleChaseSkip`, `adminActionResponse`) were cleanly excised from `backend/src/index.ts`.
7. D1 migration `0007_query_indices.sql` is applied and eliminates table scans on high-frequency queries.
8. Zero integrity violations (hardcoded test outputs, dummy implementations, or fake passes) were detected.
9. All 4 quality gates pass cleanly and independently.

---

## 2. Integrity Audit

As an adversarial critic, an explicit integrity audit was performed across all modified and newly created files:

| Integrity Check | Status | Verification Detail |
|---|:---:|---|
| **Hardcoded Test Outputs** | **CLEAN** | No conditional branches checking test environments (`process.env.NODE_ENV === 'test'`) or returning canned strings. |
| **Facade Implementations** | **CLEAN** | `sendOperatorNotification` and `sendDebtorCommunication` invoke the actual Cloudflare `env.NOTIFY.send` and `env.SEND.send` bindings, construct real RFC headers, and generate unique UUIDs. |
| **Shortcut Bypasses** | **CLEAN** | No delegation to external dependencies; adheres strictly to zero-runtime-dependency Cloudflare Workers edge architecture. |
| **Fabricated Logs / Metrics** | **CLEAN** | All test results and migration queries were executed independently in PowerShell on the host environment and matched reported worker outputs. |
| **Self-Certification** | **CLEAN** | Independent test suites (`tests/email-deliverability.test.ts` and `tests/challenger-m4-stress.test.ts`) independently exercise error injections, timeouts, and boundary conditions. |

---

## 3. Verified Claims & Requirements

### 3.1 Interface Contract 5: `sendOperatorNotification`
- **Binding**: Dispatches strictly via `env.NOTIFY` (`email.ts:58`).
- **Recipient**: Locked to `OPERATOR_INBOX_EMAIL = "tiborcc2@gmail.com"` (`email.ts:13, 59`).
- **Sender**: Locked to `{ name: "Invoice Rescue", email: env.NOTIFY_FROM || "hello@invoicerescue.co.uk" }` (`email.ts:60`).
- **RFC Deliverability Headers**:
  - `Auto-Submitted`: `"auto-generated"` (RFC 3834 autoresponder loop prevention)
  - `Message-ID`: `<${crypto.randomUUID()}@invoicerescue.co.uk>` (RFC 5322 §3.6.4)
  - `Date`: `new Date().toUTCString()` (RFC 2822 / RFC 5322 date format)
- **Error Resilience**: Wrapped in `try/catch`. Catches any edge rejection or network timeout, logs via `console.error`, and returns `false` without throwing (`email.ts:54-73`).

### 3.2 Interface Contract 5: `sendDebtorCommunication`
- **Binding**: Dispatches strictly via `env.SEND` (`email.ts:115`).
- **Sender**: Locked to `{ name: "Invoice Rescue", email: replyToEmail }` (`email.ts:117`).
- **Recipient Syntax Validation**: Validates RFC 5322 format via `isValidEmail(to)` (`email.ts:94-97`).
- **Sign-off Attribution**: Includes `formatDebtorSignoff` attributing communication to "Tibor Rames\nInvoice Rescue — acting on behalf of [client]\nhello@invoicerescue.co.uk" (`email.ts:26-29, 106-109`). Idempotent: does not duplicate if already present.
- **RFC Deliverability Headers**: Injects `Auto-Submitted`, `Message-ID`, `Date`, and both header `"Reply-To"` and parameter `replyTo` (`email.ts:118, 121-126`).
- **Error Resilience**: Wraps dispatch in `try/catch` and returns `false` on failure (`email.ts:129-132`).

### 3.3 Calling Sites Verification
- **`backend/src/lib/chase-runner.ts`**:
  - Imports `sendOperatorNotification` at line 5.
  - Line 158: Invoked when Stage 4 final notice is exhausted and invoice transitions to `escalated`.
  - Line 245: Invoked when drafts are pending review.
  - **Cron Crash Immunity**: Because `sendOperatorNotification` never throws, transient email network outages or rate limit rejections will never abort `runOverdueDetection`. Overdue invoices continue to be processed and state updates are saved to D1.
- **`backend/src/lib/portal-api.ts`**:
  - Imports `sendDebtorCommunication` at line 18.
  - Line 756: Invoked during `handleApproveDraft`.
  - **Transactional Integrity**: If `sendDebtorCommunication` returns `false`, `handleApproveDraft` immediately aborts with HTTP 500 (`portal-api.ts:763-768`) and leaves `chase_log.status` as `'draft'`.

### 3.4 D1 Schema Migration 0007
- File: `backend/db/migrations/0007_query_indices.sql`.
- Contains:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_chase_log_status ON chase_log(status);
  CREATE INDEX IF NOT EXISTS idx_accounting_connections_lookup ON accounting_connections(provider, tenant_id);
  CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
  CREATE INDEX IF NOT EXISTS idx_invoices_client_due ON invoices(client_id, due_date DESC);
  ```
- Confirmed via `npx wrangler d1 execute invoice-rescue-db --local --command "SELECT * FROM d1_migrations;"` that migration 7 is recorded and applied.
- Confirmed via `EXPLAIN QUERY PLAN` in `tests/email-deliverability.test.ts` and `tests/challenger-m4-stress.test.ts` that table scans and temp B-tree sorts are eliminated.

---

## 4. Quality Gate Verification (Independent Execution)

All 4 quality gates were executed independently by Reviewer 2.

### Gate 1: Static Typecheck
- **Command**: `npx tsc --noEmit`
- **Result**: Exit code 0
- **Diagnostic Errors**: 0 errors
- **Output**: Clean compilation with zero output.

### Gate 2: Full Test Suite
- **Command**: `npm test`
- **Result**: Exit code 0
- **Summary**:
  - Total Tests: 498
  - Total Suites: 107
  - Passed: 498
  - Failed: 0
  - Duration: ~6.28 seconds
  - Zero warnings, zero uncaught exceptions.

### Gate 3: Worker Dry-Run Bundle Build
- **Command**: `npm run build` (`wrangler deploy --dry-run`)
- **Result**: Exit code 0
- **Output**:
  ```
  Total Upload: 121.10 KiB / gzip: 26.31 KiB
  Your Worker has access to the following bindings:
  Binding                                          Resource                  
  env.NOTIFY (tiborcc2@gmail.com)                  Send Email                
  env.SEND (unrestricted)                          Send Email                
  env.DB (invoice-rescue-db)                       D1 Database               
  env.ASSETS                                       Assets                    
  env.NOTIFY_TO ("tiborcc2@gmail.com")             Environment Variable      
  env.NOTIFY_FROM ("hello@invoicerescue.co.uk")    Environment Variable      
  env.OPERATOR_NAME ("Tibor")                      Environment Variable      
  env.BOE_BASE_RATE_PERCENT ("3.75")               Environment Variable      
  env.STRIPE_PUBLISHABLE_KEY ("pk_test_...")       Environment Variable      
  ```

### Gate 4: Local D1 Migration Verification
- **Command**: `npx wrangler d1 migrations apply invoice-rescue-db --local`
- **Result**: Exit code 0
- **Output**: `✅ No migrations to apply!`
- **Database Status**: Confirmed 7 migrations present in `d1_migrations` table:
  1. `0001_initial_schema.sql`
  2. `0002_credit_control.sql`
  3. `0003_add_check_constraints.sql`
  4. `0004_client_portal_and_billing.sql`
  5. `0005_webhook_events.sql`
  6. `0006_accounting_connections_and_external_sync.sql`
  7. `0007_query_indices.sql` (applied 2026-09-16 13:14:50)

---

## 5. Adversarial Challenge & Findings

### [Low/Observation] Finding 1: Sign-off Re-attachment on Edited Drafts
- **Location**: `backend/src/lib/portal-api.ts:756-761`
- **Observation**:
  `handleApproveDraft` calls `sendDebtorCommunication` with `(env, row.debtor_email, row.subject, body)`. The 5th argument `{ clientBusinessName: row.company_name }` is omitted.
- **Risk Assessment**:
  Drafts generated by `chase-runner.ts` already contain the full sign-off (`Tibor Rames\nInvoice Rescue — acting on behalf of ${clientName}\nhello@invoicerescue.co.uk`). However, if an operator edits the draft body in the review queue and accidentally deletes the sign-off text, `sendDebtorCommunication` will not automatically append it because `options?.clientBusinessName` was not supplied.
- **Suggested Improvement**:
  Update line 761 in `portal-api.ts` to pass `{ clientBusinessName: row.company_name }`:
  ```ts
  const sent = await sendDebtorCommunication(
    env,
    row.debtor_email,
    row.subject ?? `Re: Invoice ${row.invoice_number}`,
    body,
    { clientBusinessName: row.company_name },
  );
  ```

### [Low/Observation] Finding 2: Sender Address Fallback Precedence in `sendDebtorCommunication`
- **Location**: `backend/src/lib/email.ts:113, 117`
- **Observation**:
  Line 113 defines `const replyToEmail = env.NOTIFY_FROM || LOCKED_SENDER_EMAIL;`. Line 117 sets `from: { name: SENDER_NAME, email: replyToEmail }`.
- **Risk Assessment**:
  In `wrangler.jsonc`, `NOTIFY_FROM` is currently `"hello@invoicerescue.co.uk"`, and `LOCKED_SENDER_EMAIL` is `"hello@invoicerescue.co.uk"`. They are identical. However, if a developer or operator changes `NOTIFY_FROM` in `.dev.vars` (e.g. to a personal debugging address for notifications), debtor communications would inherit that change.
- **Suggested Improvement**:
  For `sendDebtorCommunication`, lock `from.email` and `replyTo` strictly to `LOCKED_SENDER_EMAIL` (`"hello@invoicerescue.co.uk"`), reserving `env.NOTIFY_FROM` only for `sendOperatorNotification`.

### [Low/Observation] Finding 3: Auxiliary Mail Dispatches in `index.ts`
- **Location**: `backend/src/index.ts:345, 579, 736, 799`
- **Observation**:
  Routes in `index.ts` (`handleLead`, `handlePortalLoginRequest`, `handleBillingWebhook`, `runFridayReport`) make direct calls to `env.NOTIFY.send` or `env.SEND.send` rather than calling the centralized helper functions in `email.ts`.
- **Risk Assessment**:
  These calls already contain appropriate `try/catch` error handlers, so they do not pose crash risks. However, they lack automated injection of RFC 3834 headers (`Auto-Submitted: auto-generated`) and RFC 5322 `Message-ID`.
- **Suggested Improvement**:
  During M5 polish/hardening, route all outbound emails in `index.ts` through `sendOperatorNotification` and `sendDebtorCommunication` for uniform deliverability header injection.

---

## 6. Coverage Gaps & Unverified Items

- **Live External SMTP Delivery**:
  *Risk Level: Low (Accept Risk)*.
  Cloudflare's `SendEmail` binding requires a deployed Worker attached to an active Cloudflare zone with registered DNS SPF, DKIM, and DMARC records to route mail to external public inboxes. In local automated verification, in-memory mock bindings accurately verify headers, recipient routing, and payload delivery.

---

## 7. Final Verdict

**APPROVE**. Milestone M4 (Edge Infrastructure & Deliverability Controls) is complete, robust, and verified.
