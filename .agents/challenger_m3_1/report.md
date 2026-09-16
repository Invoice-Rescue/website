# Empirical Challenge Report: Milestone M3 (Portal & Queue Concurrency Stress - R3)

**Agent:** Challenger 1 (`challenger_m3_1`)  
**Role:** Empirical Challenger (Critic, Specialist)  
**Date:** 2026-09-16T12:36:00Z  
**Verdict:** **APPROVE**  

---

## Executive Summary

As Empirical Challenger 1 for Milestone M3 (Client Portal & Review Queue - R3), I executed an adversarial verification protocol against the portal API endpoints, draft approval queue, multi-tenant boundaries, email deliverability controls, and concurrency mechanisms.

A dedicated test suite consisting of **37 empirical stress tests** (`tests/challenger-m3-stress.test.ts`) was authored and executed directly against the Worker runtime and SQLite database harness. In addition, the full test suite (**462 tests across 96 suites**) and all statutory quality gates were verified.

Every stress-tested domain passed without defect:
1. **Multi-tenant isolation**: Strictly enforced with HTTP 403 Forbidden across dashboard, debtors, queue, approval, skip, and update operations. Cross-tenant leakage via query manipulation or debtor search returned zero unauthorized data.
2. **Approval idempotency and double-send prevention**: Sequential duplicate approvals returned HTTP 404 with strictly zero additional emails sent. Concurrency bursts (5 simultaneous requests) resulted in exactly 1 outbound email and clean status transitions.
3. **Skip idempotency**: Skipping an active draft updated status to `skipped` with 0 emails sent; repeated skipping returned 200 OK idempotently; skipping an already sent draft did not corrupt or overwrite its `sent` status in the database.
4. **Draft update validation**: Empty strings, whitespace-only bodies, missing fields, and malformed JSON were strictly rejected with HTTP 400 Bad Request; already reviewed drafts were protected with 404; large bodies (15KB) and Unicode symbols were preserved verbatim.
5. **Outbound email integrity**: Every dispatched email strictly enforced the locked sender `hello@invoicerescue.co.uk`, display name `Invoice Rescue`, recipient matching `debtor_email`, and Tibor Rames sign-off attribution, preserving the split-trust model.

---

## Challenge Domains & Empirical Test Evidence

### Domain 1: Multi-Tenant Isolation Probing (Tests 1.1 – 1.12)
- **Attack Vector**: Tenant A (Client ID 1) attempting to inspect or manipulate Tenant B (Client ID 2) resources via session cookie, Bearer token, query parameter tampering (`?client_id=2`), and direct route targeting.
- **Empirical Findings**:
  - `GET /api/portal/dashboard-data?client_id=2` with Tenant A cookie: **HTTP 403 Forbidden** (`ok: false`, error: `Forbidden: Cannot access another client's data.`).
  - `GET /api/portal/dashboard-data?client_id=2` with Tenant A Bearer token: **HTTP 403 Forbidden**.
  - `GET /api/portal/debtors?client_id=2` with Tenant A session: **HTTP 403 Forbidden**.
  - `GET /api/portal/debtors?search=Beta` (searching Tenant B's debtor name, invoice number, or email): Returned **0 debtors**; row-level isolation completely prevented search leakage.
  - `GET /api/admin/drafts`: Tenant A session strictly received Tenant 1 drafts only (`count: 1`, `client_id: 1`).
  - `GET /api/admin/drafts?client_id=2`: Parameter ignored for non-admin session; zero Tenant B drafts returned.
  - `POST /api/admin/drafts/200/approve` on Tenant B draft: **HTTP 403 Forbidden**, 0 emails sent, draft in DB remained `status = 'draft'`.
  - `POST /api/chase/200/approve` (legacy alias): **HTTP 403 Forbidden**, 0 emails sent.
  - `POST /api/admin/drafts/200/skip` on Tenant B draft: **HTTP 403 Forbidden**, status untouched.
  - `POST /api/chase/200/skip` (legacy alias): **HTTP 403 Forbidden**.
  - `PUT /api/admin/drafts/200` on Tenant B draft: **HTTP 403 Forbidden**, DB draft body untouched.
  - `PUT /api/chase/200` (legacy alias): **HTTP 403 Forbidden**.

### Domain 2: Approval Idempotency, Double-Send Prevention & Concurrency (Tests 2.1 – 2.5)
- **Attack Vector**: Sequential duplicate approvals, rapid double-clicks, concurrent async calls (`Promise.all`), invalid draft IDs, and drafts without debtor emails.
- **Empirical Findings**:
  - **Sequential Duplicate Approval**:
    - Call 1: HTTP 200 OK, `send.sent.length === 1`, DB transitioned to `status = 'sent'`, `outcome = 'sent'`, `reviewed_by = 'Tibor Rames'`.
    - Call 2: **HTTP 404 Not Found** ("Draft not found or already reviewed"), `send.sent.length === 1` (**ZERO duplicate email**).
    - Call 3 (via legacy `/api/chase/:id/approve`): **HTTP 404 Not Found**, `send.sent.length === 1`.
  - **Non-Existent Draft**: Calling approve on ID 999999 returned **HTTP 404**, 0 emails sent.
  - **Invalid Draft IDs**: Calling approve on ID -1 returned HTTP 404 (regex restriction); ID 0 returned **HTTP 400**, 0 emails sent.
  - **Missing Debtor Email**: Approving draft with `debtor_email = NULL` returned **HTTP 422 Unprocessable Entity**, 0 emails sent, draft status remained `draft`.
  - **Concurrency Burst**: Firing 5 simultaneous POST approve requests via `Promise.all` resulted in exactly 1 successful email dispatch (`send.sent.length === 1`) and consistent database state.

### Domain 3: Skip Idempotency & Non-Interference (Tests 3.1 – 3.4)
- **Attack Vector**: Skipping pending draft, repeated skipping, skipping already sent drafts, and skipping non-existent drafts.
- **Empirical Findings**:
  - **First Skip**: Returned HTTP 200 OK (`status: 'skipped'`), stamped `reviewed_at`, recorded `reviewed_by = 'Tibor Rames'`, dispatched 0 emails via SEND and 0 emails via NOTIFY.
  - **Repeated Skip**: Idempotent HTTP 200 OK, zero duplicate notifications or state corruption.
  - **Already Sent Draft Protection**: Calling skip on a draft with `status = 'sent'` returned 200, but **did NOT overwrite or corrupt the DB status** (remained `status = 'sent'`).
  - **Non-Existent Draft**: Returned **HTTP 404**, 0 emails sent.

### Domain 4: Draft Update Validation & In-Place Editing (Tests 4.1 – 4.8)
- **Attack Vector**: In-place edits with valid text, empty strings, whitespace-only, missing body properties, malformed JSON, edits on reviewed drafts, and high-volume Unicode payloads.
- **Empirical Findings**:
  - **Valid In-Place Edit**: Returned HTTP 200 OK; DB record updated with new body and subject while strictly preserving `status = 'draft'` awaiting human operator review.
  - **Empty String `""`**: Rejected with **HTTP 400 Bad Request** ("Draft body cannot be empty."); DB content untouched.
  - **Whitespace `"   \n\t  "`**: Rejected with **HTTP 400 Bad Request**; DB content untouched.
  - **Missing Body `{ subject: "..." }`**: Rejected with **HTTP 400 Bad Request**; DB content untouched.
  - **Malformed JSON**: Rejected with **HTTP 400 Bad Request** ("Invalid JSON body.").
  - **Edit Already Sent Draft**: Rejected with **HTTP 404** ("Draft not found or already reviewed.").
  - **Edit Already Skipped Draft**: Rejected with **HTTP 404** ("Draft not found or already reviewed.").
  - **Large Legal Notice & Unicode**: 15KB statutory claim text with symbols (`£`, `€`, `⚡`, `⚠️`) saved and retrieved verbatim without corruption.

### Domain 5: Outbound Email Integrity & Sign-Off Model (Tests 5.1 – 5.2)
- **Attack Vector**: Verifying outbound email fields against specification constraints: locked sender address, display name, recipient matching, and human sign-off attribution.
- **Empirical Findings**:
  - `to`: Strictly matched `debtor_email` (`accounts.payable@debtorfirm.co.uk`).
  - `from.email`: Strictly locked to `hello@invoicerescue.co.uk`.
  - `from.name`: Strictly locked to `Invoice Rescue`.
  - `text`: Verified inclusion of "Tibor Rames" on behalf of client sign-off.
  - `reviewed_by`: Audit trail recorded `Tibor Rames` in `chase_log`.
  - `split-trust`: Operator inbox `env.NOTIFY` received 0 debtor emails.
  - `custom text delivery`: When operator provided custom edited text during `POST /approve`, the custom message was sent to the debtor and saved to the database.

### Domain 6: Review Queue Statutory Financial Calculations (Test 6.1)
- **Attack Vector**: Checking calculations in `GET /api/admin/drafts` across all 3 UK Late Payment statutory tiers and Bank of England base rate daily accrual.
- **Empirical Findings**:
  - Tier 1 (< £1,000 debt: £850.00 overdue 5d at 3.75% BoE):
    - `fixed_compensation_pence`: 4,000p (£40.00).
    - `statutory_interest_pence`: 137p (£1.37).
    - `total_claim_pence`: 89,137p (£891.37) — exact match.
  - Tier 2 (£1,000 to £9,999.99 debt: £4,500.00 overdue 12d at 3.75% BoE):
    - `fixed_compensation_pence`: 7,000p (£70.00).
    - `statutory_interest_pence`: 1,738p (£17.38).
    - `total_claim_pence`: 458,738p (£4,587.38) — exact match.
  - Tier 3 (≥ £10,000 debt: £15,000.00 overdue 25d at 3.75% BoE):
    - `fixed_compensation_pence`: 10,000p (£100.00).
    - `statutory_interest_pence`: 12,072p (£120.72).
    - `total_claim_pence`: 1,522,072p (£15,220.72) — exact match.

### Domain 7: Authentication & Route Security (Tests 7.1 – 7.3)
- Unauthenticated access to approve/skip/edit returned **HTTP 401 Unauthorized**.
- Invalid HTTP Basic Auth credentials returned **HTTP 401 Unauthorized**.
- HTML form submission without `Accept: application/json` properly returned **HTTP 303 See Other** with `Location: /admin`.

### Domain 8: Adversarial SQL Injection & Malicious Parameters (Tests 8.1 – 8.2)
- SQL injection vectors in `search`, `sort`, `dir`, `stage`, and `status` (`' OR '1'='1`, `; DROP TABLE invoices; --`) executed safely via parameterized bindings and in-memory sort dispatch without crashes or schema drops.
- Malicious `client_id` query parameters (`NaN`, `undefined`, negative numbers, injection strings) were safely coerced without unhandled 500 exceptions.

---

## Quality Gate Verification

| Quality Gate | Command | Result | Details |
|---|---|---|---|
| **TypeScript Compilation** | `npx tsc --noEmit` | **PASS (Code 0)** | 0 type errors across entire codebase |
| **Dedicated Stress Suite** | `npx tsx --test tests/challenger-m3-stress.test.ts` | **PASS (Code 0)** | 37 of 37 tests passed (duration: 1,063ms) |
| **Full Project Test Suite** | `npm test` | **PASS (Code 0)** | 462 of 462 tests passed across 96 suites (duration: 4,645ms) |
| **Production Dry-Run Build** | `npm run build` | **PASS (Code 0)** | `wrangler deploy --dry-run` bundled cleanly with 20 static assets |
| **Local D1 Migrations** | `npx wrangler d1 migrations apply invoice-rescue-db --local` | **PASS (Code 0)** | Schema up to date ("No migrations to apply!") |

---

## Final Verdict

**APPROVE**.

The Milestone M3 implementation for the Client Portal & Review Queue (R3) adheres strictly to multi-tenant isolation, idempotency, email integrity, and statutory credit control calculations. Zero vulnerabilities or regressions were discovered.
