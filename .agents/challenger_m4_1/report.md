# Milestone M4 Challenger 1 Report: Split-Trust Email Resilience & Deliverability Stress (R4)

**Challenger**: Challenger 1 (`challenger_m4_1`) — Empirical Challenger & Adversarial Specialist  
**Target Milestone**: M4 — Edge Infrastructure & Deliverability Controls (R4)  
**Project**: Invoice Rescue (`invoice-rescue`)  
**Verdict**: **APPROVE**  
**Date**: 2026-09-16  

---

## 1. Executive Summary & Verdict

Milestone M4 implementation by `worker_m4` was subjected to rigorous empirical adversarial challenge focusing on:
1. **Email Failure Resilience in `runOverdueDetection`**: Tested under active network timeout, HTTP 429, TypeError, and AbortError simulations during Stage 4 escalation and queue digest reporting. Verified that `sendOperatorNotification` catches all errors, returns `false`, and the cron runner finishes processing all remaining invoices to completion without crashing.
2. **Split-Trust Boundary Enforcement**: Probed recipient lockdown and binding isolation. Verified that `sendOperatorNotification` cannot be hijacked to send to an arbitrary address and is strictly locked to `tiborcc2@gmail.com`. Confirmed zero cross-binding leakage between `env.NOTIFY` and `env.SEND`.
3. **Debtor Email Deliverability**: Verified sender constraints (`Invoice Rescue <hello@invoicerescue.co.uk>`), automatic and idempotent Tibor Rames sign-off formatting on behalf of clients, and full RFC header compliance (`Auto-Submitted: auto-generated`, `Message-ID: <${uuid}@invoicerescue.co.uk>`, `Date: RFC 2822`, `Reply-To: hello@invoicerescue.co.uk`).
4. **Invalid Debtor Email Handling**: Probed malformed email strings, whitespace, CRLF injection attempts (`\r\nBcc:`), and non-string inputs. Confirmed all are safely caught and rejected, and `handleApproveDraft` preserves transactional integrity (drafts remain in `'draft'` status).
5. **High Load and Unicode Preservations**: Verified 1MB body payloads and multi-lingual/emoji text preservation (`£`, `🚨`, `⚠️`, Cyrillic, Chinese).

**Verdict**: **APPROVE**. All 18 adversarial stress tests in `tests/challenger-m4-stress.test.ts` passed (100%), full suite passed with 498/498 tests, static type checking passed with zero errors, and Cloudflare Worker dry-run build bundled cleanly.

---

## 2. Empirical Test Matrix

An independent adversarial stress harness was authored and executed in `tests/challenger-m4-stress.test.ts`:

| # | Test Scenario | Expected Behavior | Observed Result | Status |
|---|---------------|-------------------|-----------------|--------|
| **1.1** | Cron resilience under Stage 4 email failure | Invoices 1001 & 1003 escalate, cron continues, drafts 1002 & 1004 created despite `env.NOTIFY.send` network timeout | Invoices 1001/1003 transitioned to `'escalated'`, drafts 1002/1004 created in `chase_log`, cron returned `invoicesEscalated: 2, draftsCreated: 2` | **PASS** |
| **1.2** | Fatal `TypeError` in `env.NOTIFY.send` | `sendOperatorNotification` catches error and returns `false` without throwing | Caught error, returned `false`, no unhandled exception | **PASS** |
| **1.3** | `AbortError` / timeout deadline in `env.NOTIFY.send` | Returns `false` cleanly | Caught `AbortError`, returned `false` | **PASS** |
| **2.1** | Recipient hijacking probing on `sendOperatorNotification` | Extra arguments or environment tampering cannot divert recipient away from `tiborcc2@gmail.com` | Target recipient strictly preserved as `tiborcc2@gmail.com`; zero dispatches to attacker address | **PASS** |
| **2.2** | Binding isolation: operator notification using `SEND` | `sendOperatorNotification` never invokes `env.SEND` | Zero calls recorded on `env.SEND` binding | **PASS** |
| **2.3** | Binding isolation: debtor communication using `NOTIFY` | `sendDebtorCommunication` never invokes `env.NOTIFY` | Zero calls recorded on `env.NOTIFY` binding | **PASS** |
| **2.4** | Missing `env.NOTIFY` binding | Fails closed, logs error, returns `false` | Returned `false`, zero side effects | **PASS** |
| **2.5** | Missing `env.SEND` binding | Fails closed, logs error, returns `false` | Returned `false`, zero side effects | **PASS** |
| **3.1** | Strict debtor sender identity | Sender must be `Invoice Rescue <hello@invoicerescue.co.uk>` | Name: `"Invoice Rescue"`, Email: `"hello@invoicerescue.co.uk"` | **PASS** |
| **3.2** | RFC Deliverability headers verification | Includes `Auto-Submitted: auto-generated`, valid UUID `Message-ID`, RFC 2822 `Date`, and `Reply-To` | All 4 headers present with exact format matching RFC 3834, RFC 5322, and RFC 2822 | **PASS** |
| **3.3** | `Message-ID` collision stress | 50 consecutive dispatches must produce 50 unique IDs | 50/50 unique UUID-based Message-IDs | **PASS** |
| **3.4** | Sign-off formatting with client business name | Appends Tibor Rames sign-off referencing client business name | Exactly appends: `Tibor Rames\nInvoice Rescue — acting on behalf of Apex Design Studio Ltd\nhello@invoicerescue.co.uk` | **PASS** |
| **3.5** | Sign-off idempotency | Does not duplicate sign-off if already present in body | Single occurrence of `Tibor Rames` preserved | **PASS** |
| **3.6** | Sign-off fallback | Defaults to "our client" when business name is empty/omitted | `acting on behalf of our client` rendered | **PASS** |
| **4.1** | Malformed and injection emails | Rejects empty, whitespace, missing domain/TLD, CRLF injection (`\r\nBcc:`) | All 15 adversarial variants rejected by `isValidEmail` and `sendDebtorCommunication`; 0 emails sent | **PASS** |
| **4.2** | Draft approval with invalid debtor email | Returns 422/500, does not send email, draft stays `'draft'` | Draft remains `'draft'` in D1, HTTP 422 returned, 0 emails dispatched | **PASS** |
| **5.1** | 1MB payload stress | Handles large message without crashing or truncating headers | Dispatched cleanly with full 1MB body and intact RFC headers | **PASS** |
| **5.2** | Unicode, currency symbols, and emoji preservation | Preserves `£`, `🚨`, `⚠️`, accents, and non-Latin scripts | Subject and body preserved verbatim across dispatches | **PASS** |

---

## 3. Empirical Verification Logs

### A. Challenger Stress Suite Execution
```
$ npx tsx --test tests/challenger-m4-stress.test.ts
▶ Milestone M4 Stress Suite — Challenger 1 (Split-Trust Email Resilience & Deliverability)
  ▶ 1. Email Failure Resilience in runOverdueDetection
    ✔ 1.1 Network error during Stage 4 escalation does not crash cron and completes all remaining invoices (749.2793ms)
    ✔ 1.2 Unhandled TypeError in env.NOTIFY is safely caught by sendOperatorNotification boundary (12.2857ms)
    ✔ 1.3 AbortError / Timeout simulation in sendOperatorNotification returns false cleanly (11.2377ms)
  ✔ 1. Email Failure Resilience in runOverdueDetection (775.0959ms)
  ▶ 2. Split-Trust Boundary Enforcement
    ✔ 2.1 sendOperatorNotification recipient is strictly immutable and hardcoded to tiborcc2@gmail.com (15.4422ms)
    ✔ 2.2 sendOperatorNotification never dispatches through env.SEND binding (22.7111ms)
    ✔ 2.3 sendDebtorCommunication never dispatches through env.NOTIFY binding (9.9547ms)
    ✔ 2.4 Missing NOTIFY binding fails closed without throwing or routing elsewhere (44.8208ms)
    ✔ 2.5 Missing SEND binding fails closed without throwing or routing elsewhere (10.0286ms)
  ✔ 2. Split-Trust Boundary Enforcement (103.9342ms)
  ▶ 3. Debtor Email Deliverability & RFC Compliance
    ✔ 3.1 Strict sender address and display name constraints (9.4399ms)
    ✔ 3.2 Full deliverability header inspection: Auto-Submitted, Message-ID, Date, Reply-To (28.4404ms)
    ✔ 3.3 Message-ID uniqueness across consecutive dispatches (zero collisions) (16.7311ms)
    ✔ 3.4 Sign-off formatting: automatically appends Tibor Rames sign-off on behalf of client (36.0441ms)
    ✔ 3.5 Sign-off idempotency: does not duplicate sign-off if already present in body (10.9637ms)
    ✔ 3.6 Default sign-off client name when clientBusinessName is omitted or empty (0.2926ms)
  ✔ 3. Debtor Email Deliverability & RFC Compliance (102.5744ms)
  ▶ 4. Invalid Debtor Email Handling & Boundary Validation
    ✔ 4.1 Rejects adversarial, malformed, and injection email addresses (21.6685ms)
    ✔ 4.2 handleApproveDraft rejects draft approval when debtor email is invalid syntax (48.3291ms)
  ✔ 4. Invalid Debtor Email Handling & Boundary Validation (70.3214ms)
  ▶ 5. High-Load, Unicode, and Boundary Stress
    ✔ 5.1 Handles massive 1MB email body text without crashing or truncating headers (12.0148ms)
    ✔ 5.2 Preserves Unicode, UTF-8 symbols, emojis, and pound currency symbols (43.6824ms)
  ✔ 5. High-Load, Unicode, and Boundary Stress (55.9642ms)
✔ Milestone M4 Stress Suite — Challenger 1 (Split-Trust Email Resilience & Deliverability) (1113.9192ms)
ℹ tests 18
ℹ suites 6
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2616.7643
```

### B. Full Test Suite Execution
```
$ npm test
ℹ tests 498
ℹ suites 107
ℹ pass 498
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6641.4106
```

### C. TypeScript Type Check
```
$ npm run typecheck
> tsc --noEmit
Exit code: 0
```

### D. Cloudflare Worker Edge Build (Dry-Run)
```
$ npm run build
> wrangler deploy --dry-run
✨ Read 20 files from the assets directory D:\Dev\Workspaces\Active\invoice-rescue\frontend
Total Upload: 121.10 KiB / gzip: 26.31 KiB
Your Worker has access to the following bindings:
Binding                                Resource
env.NOTIFY (tiborcc2@gmail.com)        Send Email
env.SEND (unrestricted)                Send Email
env.DB (invoice-rescue-db)             D1 Database
env.ASSETS                             Assets
env.NOTIFY_TO ("tiborcc2@gmail.com")   Environment Variable
env.NOTIFY_FROM ("hello@invoicerescue.co.uk") Environment Variable
env.OPERATOR_NAME ("Tibor")            Environment Variable
env.BOE_BASE_RATE_PERCENT ("3.75")     Environment Variable
env.STRIPE_PUBLISHABLE_KEY ("...")     Environment Variable
--dry-run: exiting now.
Exit code: 0
```

### E. D1 Local Migrations Verification
```
$ npx wrangler d1 migrations apply invoice-rescue-db --local
✅ No migrations to apply!

$ npx wrangler d1 execute invoice-rescue-db --local --command "SELECT * FROM d1_migrations ORDER BY id ASC;"
[
  { "id": 1, "name": "0001_initial_schema.sql" },
  { "id": 2, "name": "0002_credit_control.sql" },
  { "id": 3, "name": "0003_add_check_constraints.sql" },
  { "id": 4, "name": "0004_client_portal_and_billing.sql" },
  { "id": 5, "name": "0005_webhook_events.sql" },
  { "id": 6, "name": "0006_accounting_connections_and_external_sync.sql" },
  { "id": 7, "name": "0007_query_indices.sql" }
]
```

---

## 4. Findings & Observations

1. **Failure Resilience**: The defensive error boundary around `env.NOTIFY.send` in `sendOperatorNotification` successfully prevents transient email failures from aborting the scheduled cron job. When `NOTIFY` fails on stage 4 escalation, the database transaction persists the transition to `'escalated'`, and the runner cleanly proceeds to process subsequent invoices and drafts.
2. **Strict Split-Trust Architecture**: `sendOperatorNotification` enforces a hardcoded recipient constant (`OPERATOR_INBOX_EMAIL = "tiborcc2@gmail.com"`), preventing malicious diversion or parameter injection. `sendDebtorCommunication` strictly binds to `env.SEND`. Cross-binding calls do not exist.
3. **Deliverability Conformance**: RFC 3834 autoresponder loop prevention (`Auto-Submitted: auto-generated`), RFC 5322 unique Message-IDs, RFC 2822 UTC timestamp Date headers, and proper Reply-To parameters are verified on all outbound dispatches.
4. **Zero Regressions**: All 480 existing tests continue to pass alongside the 18 new adversarial tests (498 passing in total).

---

## 5. Verdict

**APPROVE**. Milestone M4 satisfies all email deliverability, split-trust, error resilience, and edge deployment requirements.
