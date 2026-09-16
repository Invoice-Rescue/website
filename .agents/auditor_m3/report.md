# Forensic Integrity Audit Report: Milestone M3 (Client Portal & Review Queue - R3)

**Target Milestone**: M3 (Client Portal & Review Queue - R3)  
**Integrity Mode**: Demo (per `ORIGINAL_REQUEST.md`)  
**Auditor**: Forensic Integrity Auditor  
**Date**: 2026-09-16T12:35:00Z  
**Verdict**: **CLEAN** (No Integrity Violations Detected)

---

## 1. Executive Summary

A comprehensive forensic audit was conducted on all artifacts delivered for Milestone M3:
- `backend/src/lib/portal-api.ts`
- `backend/src/index.ts`
- `frontend/dashboard/js/dashboard.js`
- `tests/portal-endpoints.test.ts`
- `package.json`

The audit evaluated compliance against the ground-truth requirements specified in `ORIGINAL_REQUEST.md`, project architecture in `PROJECT.md`, and clean code engineering non-negotiables.

All four quality gates passed independently. Static analysis confirmed authentic business logic, parameterized SQL queries, zero external runtime dependencies, accurate statutory calculations, and strict locked-sender enforcement. Runtime testing demonstrated robust multi-tenant boundary controls and non-tautological assertions.

**Final Verdict**: **CLEAN**. Milestone M3 is fully verified and compliant.

---

## 2. Integrity Mode & Constraint Verification

Per `ORIGINAL_REQUEST.md` (Integrity Mode: `demo`), all general prohibited patterns were audited:

| # | Prohibited Pattern | Evaluation | Status |
|---|-------------------|------------|--------|
| 1 | Hardcoded test results | No embedded test strings, hardcoded outputs, or PASS/FAIL flags in `portal-api.ts` or `dashboard.js`. | **PASS** |
| 2 | Facade implementations | All 6 endpoints implement full D1 query execution, date math, and state machine transitions. | **PASS** |
| 3 | Fabricated verification outputs | No pre-populated `.log`, `*result*`, or `*output*` artifacts exist in the repository. | **PASS** |
| 4 | Self-certifying tests | `tests/portal-endpoints.test.ts` tests execute real worker routing, modify in-memory D1 SQLite, and inspect database state and email mock queues. | **PASS** |
| 5 | Execution delegation | All endpoints run natively on Cloudflare Workers edge runtime with zero external runtime packages. | **PASS** |
| 6 | Code copying / external tools | Genuine implementation built to project specifications and D1 database schema. | **PASS** |

---

## 3. Detailed Static Analysis

### 3.1 Parameterized SQL Queries & Data Layer Integrity
Every D1 query across the 6 endpoints in `backend/src/lib/portal-api.ts` is strictly parameterized:
- `handlePortalDashboardData`: `SELECT ... FROM clients WHERE id = ?1` and `SELECT ... FROM invoices WHERE client_id = ?1` (`.bind(clientId)`).
- `handlePortalDebtors`: Invoices are scoped by `client_id = ?1`. Multi-criteria filtering (search, stage, status) and multi-column sorting are executed in-memory after tenant-scoped retrieval, preventing SQL injection vulnerabilities.
- `handleGetDrafts`: Query conditionally adds `AND c.id = ?1` and binds `targetCid`.
- `handleApproveDraft`: `SELECT ... WHERE cl.id = ?1` (`.bind(draftId)`); `UPDATE chase_log SET status = 'sent', body = ?2, outcome = 'sent', sent_at = datetime('now'), reviewed_at = datetime('now'), reviewed_by = ?3 WHERE id = ?1 AND status = 'draft'` (`.bind(draftId, body, reviewerName)`).
- `handleSkipDraft`: Parameterized update binding `draftId` and `reviewerName`.
- `handleUpdateDraft`: Parameterized update binding `draftId`, `body`, and `updatedSubject`.

### 3.2 Statutory Mathematical Calculations
- Accrual Formula: `statutoryInterestPence` executes `Math.round(((amountPence * (boeBaseRatePercent + 8)) / 100 / 365) * daysOverdue)`.
- Compensation Bands: `< £1,000` (£40), `£1,000–£9,999.99` (£70), `≥ £10,000` (£100) per the UK Late Payment of Commercial Debts Act 1998.
- Aging Buckets: Days overdue are partitioned into `1-7d`, `8-14d`, `15-21d`, `22d+`. Percentage allocation uses `p4 = Math.max(0, 100 - (p1 + p2 + p3))` ensuring an exact 100% total sum without drift.

### 3.3 Zero External Runtime Dependencies
Inspection of `package.json` confirmed:
- `"dependencies"`: Non-existent (zero packages installed for runtime).
- `"devDependencies"`: `@cloudflare/workers-types`, `@types/node`, `markdownlint-cli2`, `tsx`, `typescript`, `wrangler`.
- Backend uses standard Web APIs (`Request`, `Response`, `fetch`, `crypto.subtle`, URL/URLSearchParams).

### 3.4 Locked Sender Model & Attribution
- Sender email is permanently locked to `hello@invoicerescue.co.uk` (or `env.NOTIFY_FROM`).
- Sender name is `"Invoice Rescue"`.
- Operator reviewer attribution defaults to `"Tibor Rames"` (or `env.OPERATOR_NAME`).
- Outbound chase emails are dispatched strictly via `env.SEND`.
- Frontend review queue features a locked sender indicator and an operator sign-off notice: *"Drafted by AI, verified by Tibor Rames on behalf of [Client]"*.

### 3.5 WCAG 2.2 Level AA Accessibility
In `frontend/dashboard/js/dashboard.js`:
- Keyboard Navigation: Table sort headers (`th.sortable`) listen for `keydown` (`Enter` and `Space`) in addition to click events.
- ARIA Attributes: Sort headers dynamically toggle `aria-sort="ascending"|"descending"|"none"`.
- Accessible State: Progress bar `.aging-gauge` updates `aria-valuetext` with aging percentages.
- Focus Restoration: In-place draft editing restores keyboard focus to `#btn-edit-toggle-${id}` upon exiting edit mode.

---

## 4. Quality Gates Verification

All 4 quality gates were executed independently by the Forensic Auditor:

### Gate 1: TypeScript Compilation (`npx tsc --noEmit`)
- Command: `npx tsc --noEmit`
- Result: **PASS** (Exit code 0, 0 type errors).

### Gate 2: Full Test Suite (`npm test`)
- Command: `npm test` (`tsx --test tests/**/*.test.ts`)
- Result: **PASS** (Exit code 0).
- Metrics: **420 passed out of 420 tests** across 87 suites (0 failures, 0 skipped, 0 cancelled).
- Dedicated portal test suite (`tests/portal-endpoints.test.ts`): 27 passed out of 27.
- Dedicated empirical challenge suite (`tests/m3-empirical-challenge.test.ts`): 17 passed out of 17.

### Gate 3: Worker Deployment Bundle (`npm run build`)
- Command: `npm run build` (`wrangler deploy --dry-run`)
- Result: **PASS** (Exit code 0).
- Assets: Packaged 20 static files from `frontend/` directory (118.46 KiB).
- Bindings confirmed: `env.NOTIFY`, `env.SEND`, `env.DB`, `env.ASSETS`.

### Gate 4: Local D1 Schema Migrations (`npx wrangler d1 migrations apply invoice-rescue-db --local`)
- Command: `npx wrangler d1 migrations apply invoice-rescue-db --local`
- Result: **PASS** (Exit code 0).
- Status: "No migrations to apply!" (All migrations up through 0006 are cleanly applied).

---

## 5. Adversarial Stress-Testing & Edge Case Analysis

| Attack Vector | Scenario Tested | Observed Behavior | Verdict |
|---------------|-----------------|-------------------|---------|
| **Cross-Tenant Access** | Client 1 requests `/api/portal/dashboard-data?client_id=2` | Blocked immediately with HTTP 403 Forbidden | **SECURE** |
| **Draft Tampering** | Client 1 attempts to edit or approve Client 2's draft in `/api/admin/drafts/:id` | Blocked immediately with HTTP 403 Forbidden | **SECURE** |
| **Draft Double-Review** | Attempting to approve an already sent or non-existent draft | Returns HTTP 404 "Draft not found or already reviewed." | **SECURE** |
| **Empty Message Body** | Operator attempts to save empty string or whitespace draft edit | Rejected with HTTP 400 Bad Request | **SECURE** |
| **Future Due Dates** | Invoice with due date in the future (`now + 5 days`) | Calculates `days_overdue = 0`, stages as Stage 0 ("Current") | **SECURE** |
| **Zero Days Overdue** | Draft evaluated at exactly 0 days overdue | Statutory interest returns 0p without NaN or negative values | **SECURE** |

---

## 6. Forensic Audit Conclusion

The Milestone M3 deliverable is authentic, robust, securely isolated, and adheres to all technical constraints. No prohibited shortcuts, facade implementations, or integrity violations were found.

**Audit Verdict**: **CLEAN**
