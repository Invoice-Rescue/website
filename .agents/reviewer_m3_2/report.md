# Milestone M3 Independent Quality Review & Adversarial Challenge Report

**Reviewer:** Reviewer 2 (`reviewer_m3_2`)  
**Roles:** Quality Reviewer, Adversarial Critic  
**Milestone:** M3 (Client Portal & Review Queue - R3)  
**Date:** 2026-09-16T13:34:00Z  
**Verdict:** **REQUEST_CHANGES**

---

## 1. Executive Summary

Milestone M3 implements the Client Portal, Debtor Ledger, and Human-in-the-Loop Review Queue for Invoice Rescue. The implementation introduces `backend/src/lib/portal-api.ts` (6 REST endpoints), updates route dispatch in `backend/src/index.ts`, and wires the responsive frontend assets (`frontend/dashboard/js/dashboard.js`, `index.html`, `debtors.html`, `approval-queue.html`, `dashboard.css`).

Three of the four mandatory quality gates pass cleanly (`tsc --noEmit`, `npm run build`, and `npx wrangler d1 migrations apply`). However, **Quality Gate 2 (`npm test`) fails with exit code 1** due to a failing assertion in `tests/m3-empirical-challenge.test.ts:460` (test 3.2). In addition, code inspection revealed two frontend logic and error-handling bugs in `frontend/dashboard/js/dashboard.js`:
1. Live overview dashboard metrics are inadvertently overwritten by mock session storage when a tenant has zero recent activity feed entries.
2. The draft approval queue performs optimistic UI dismissal without verifying whether the backend responded with HTTP 422 (e.g., missing debtor email) or HTTP 403 (forbidden).

Consequently, the required verdict is **REQUEST_CHANGES**.

---

## 2. Quality Gate Verification Results

| Quality Gate | Command | Status | Duration | Output / Details |
|--------------|---------|:------:|:--------:|------------------|
| **1. TypeScript Compilation** | `npx tsc --noEmit` | **PASS** | ~3.0s | Exited code 0, 0 type errors. Strict typing intact. |
| **2. Automated Test Suite** | `npm test` | **FAIL** | ~5.5s | Exited code 1. **419 passed, 1 failed** (out of 420 tests across 87 suites). |
| **3. Worker Deploy Dry-Run** | `npm run build` | **PASS** | ~5.8s | Exited code 0. Wrangler bundled 20 static assets (118.46 KiB) with all 9 env/D1/email bindings. |
| **4. Local D1 Migrations** | `npx wrangler d1 migrations apply invoice-rescue-db --local` | **PASS** | ~7.8s | Exited code 0. "✅ No migrations to apply!" |

### Quality Gate 2 Failure Breakdown:
- **Test File:** `tests/m3-empirical-challenge.test.ts:436`
- **Subtest:** `3.2 Statutory interest calculation produces exact pence with zero rounding drift across multiple BoE rates and periods`
- **Error:** `AssertionError [ERR_ASSERTION]: Statutory interest mismatch for £6400.00 overdue 9d at 3.75% BoE: got 1854, expected 1853 (1854 !== 1853)`
- **Analysis:**
  - Formula: $\text{Interest} = \text{round}\left(\frac{\text{Principal} \times (\text{BaseRate} + 8)}{100 \times 365} \times \text{DaysOverdue}\right)$
  - Calculation: $\frac{640,000 \times 11.75}{36,500} \times 9 = 206.027397... \times 9 = 1,854.24657... \xrightarrow{\text{round}} \mathbf{1854}$ pence.
  - The implementation in `backend/src/lib/statutory-interest.ts` produced 1854 pence, which is mathematically exact.
  - However, `tests/m3-empirical-challenge.test.ts` line 442 defined `{ amount: 640000, days: 9, rate: 3.75, expected: 1853 }`, creating an off-by-one test specification defect that breaks the test gate. Per reviewer constraints, this failure is reported and must be remediated.

---

## 3. Review Findings & Defect Catalog

### [Critical / Quality Gate Blocker] Finding 1: Test Suite Regression in `tests/m3-empirical-challenge.test.ts`
- **What:** `npm test` fails with exit code 1 due to an erroneous expected value in the test assertion table.
- **Where:** `tests/m3-empirical-challenge.test.ts:442`
- **Why:** The test harness expects 1853 pence for an invoice of £6,400.00 overdue 9 days at 3.75% BoE rate (11.75% total). Mathematical evaluation yields $1854.2465...$, which correctly rounds to 1854. Line 442 causes `assert.strictEqual(calculated, tc.expected)` to throw, blocking the CI/test gate.
- **Suggestion:** Correct line 442 of `tests/m3-empirical-challenge.test.ts` from `expected: 1853` to `expected: 1854`.

### [Major / Functional] Finding 2: Live Dashboard Metrics Overwritten by Mock Session Data on Empty Activity
- **What:** On `index.html`, when `handlePortalDashboardData` returns `ok: true` but `d.recentActivity` is empty (`[]`), the overview dashboard overwrites the real live metrics with mock session data.
- **Where:** `frontend/dashboard/js/dashboard.js`, lines 594–628
- **Why:** In `initOverviewDashboard()`, lines 525–592 populate live metrics from `/api/portal/dashboard-data`. At line 595, the function checks:
  ```javascript
  const activityFeed = document.getElementById("activity-feed-list");
  if (activityFeed && Array.isArray(d.recentActivity) && d.recentActivity.length > 0) {
    activityFeed.innerHTML = ...;
    return; // <--- ONLY RETURNS IF recentActivity.length > 0!
  }
  ```
  If a tenant is newly onboarded or has 0 chase activities recorded, `d.recentActivity.length === 0`. The function fails to return, drops down into line 627 (`// 2. Fallback to session / mock data`), and re-executes lines 671–722, overwriting live D1 totals with `getStoredInvoices()` mock data (`DEFAULT_INVOICES`).
- **Suggestion:** Add an unconditional `return;` after completing the live API population block at line 625, ensuring fallback logic executes only if `!apiRes.ok || !apiRes.data`.

### [Major / Resilience] Finding 3: Optimistic Approval Queue Dismissal Without Error Handling
- **What:** In `approval-queue.html`, clicking "Approve & Send" permanently removes the draft from the review queue and displays a success toast even if the backend returns HTTP 422 (e.g. missing debtor email) or HTTP 403 (forbidden).
- **Where:** `frontend/dashboard/js/dashboard.js`, lines 1250–1284
- **Why:** `window.InvoiceRescue.approveDraft(id)` calls `apiFetch('/api/admin/drafts/${id}/approve', ...)`, but does not inspect `res.ok`. Regardless of whether the server responded with 422, 403, or 500, lines 1282–1304 execute:
  ```javascript
  drafts = drafts.filter((d) => d.id !== id);
  saveStoredDrafts(drafts);
  showToast(`Approved and dispatched chase message for ${draft.debtor_name}`);
  renderQueue();
  ```
  The user is given false feedback that the email was dispatched when in reality the backend rejected it and no email was sent.
- **Suggestion:** Check `res.ok` before updating local state. If `!res.ok`, re-enable the button, cancel the spinner, and display an error toast: `showToast(res.data?.error || "Failed to approve draft", "danger")`.

### [Minor / Robustness] Finding 4: `apiFetch` Throws SyntaxError on Non-JSON or Empty Responses
- **What:** `apiFetch` in `dashboard.js` blindly calls `await res.json()` without inspecting `Content-Type` or status 204.
- **Where:** `frontend/dashboard/js/dashboard.js`, lines 486–502
- **Why:** If an endpoint returns 204 No Content or HTML, `res.json()` throws a `SyntaxError`, which causes `catch (err)` to return `{ ok: false, status: 0, error: err, data: null }`, wiping out the true HTTP status code.
- **Suggestion:** Check `res.status === 204` or verify `res.headers.get("content-type")?.includes("application/json")` before parsing JSON.

---

## 4. Verification of Milestone Requirements

### 1. Unified `apiFetch` and Fallback Logic
- **Verified:** `apiFetch` handles live endpoints `/api/portal/dashboard-data`, `/api/portal/debtors`, and `/api/admin/drafts`.
- **Fallback:** When unauthenticated or offline, `dashboard.js` falls back to `sessionStorage` (`ir_dashboard_invoices`, `ir_dashboard_drafts`, `ir_dashboard_activities`) and seeded mock datasets.
- **Backend Demo Fallback:** `/api/portal/dashboard-data` and `/api/portal/debtors` fall back to the first active client in D1 when unauthenticated.

### 2. Debtor Ledger Table (Search & Multi-Column Sorting)
- **Verified:** 150ms debounce on input (`searchInput.addEventListener("input")` with `clearTimeout(debounceTimer)` and `150ms` delay).
- **Search Scope:** Matches debtor name, invoice number, and email.
- **Filters:** Stage filters (Stage 1 to 4) and status filters (`overdue`, `promised`, `paid`, `disputed`).
- **Sorting:** Multi-column sorting on `days_overdue`, `amount_pence`, `due_date`, `debtor_name`, `invoice_number`, `status`, `stage` with ASC/DESC toggles.

### 3. Draft Approval Queue
- **Verified:** Cards display full statutory breakdown:
  - Principal invoice amount
  - Days overdue
  - Fixed statutory compensation (£40, £70, or £100 per statutory bands)
  - Bank of England base rate + 8% daily simple interest
  - Total claim owed
- **In-Place Editing:** Clicking "Edit Message" opens `<textarea class="message-edit-area">`, enables live character count, saves to D1 via `PUT /api/admin/drafts/:id`, and updates DOM text via `.textContent`.
- **Approve & Send:** Calls `POST /api/admin/drafts/:id/approve` (or fallback `/api/chase/:id/approve`), verifies debtor email, dispatches email via `env.SEND` locked to `hello@invoicerescue.co.uk`, sets `status = 'sent'`, and records reviewer `Tibor Rames`.
- **Skip / Defer:** Calls `POST /api/admin/drafts/:id/skip`, transitions status to `'skipped'`, sends zero emails.

### 4. WCAG 2.2 Level AA Accessibility
- **Table Keyboard Navigation:** `th.sortable` elements have `tabindex="0"`, `role="button"`, and listen to both `Enter` and `Space` keyboard events.
- **Sort State:** Updates `aria-sort="ascending"`, `aria-sort="descending"`, and `aria-sort="none"` across all sortable headers.
- **Dynamic Progressbar:** `.aging-gauge[role="progressbar"]` dynamically updates `aria-valuetext` (e.g. `Stage 1: 25%, Stage 2: 25%, Stage 3: 25%, Stage 4: 25%`).
- **Focus Restoration:** Exiting edit mode in the approval queue explicitly calls `toggleBtn.focus()` (`#btn-edit-toggle-${draft.id}`), preserving keyboard context.
- **Color Contrast:**
  - Light mode: `--ink` (`#171B21`) on `--paper` (`#FBFAF7`) has a contrast ratio of **17.34:1** (exceeding >15:1 requirement).
  - Dark mode: `--ink` (`#F0F4F8`) on `--paper` (`#0E1217`) has a contrast ratio of **17.09:1** (exceeding >15:1 requirement).
- **Skip Links & Landmarks:** `<a href="#main" class="skip-link">` present on all 3 pages; semantic `<header>`, `<main id="main">`, `<nav>`, `<section>`, `<article>`, and `<footer>` elements.

### 5. Responsive Layouts & Persistent Theming
- **Responsive Layouts:** CSS grid and flex adapt across 1024px (2-column metrics), 768px (stacked mobile header, 1-column metrics, stacked draft actions, full-width search), and 480px (stacked claim breakdown ribbon).
- **Theming:** Dark/light toggle saves `invoice_rescue_theme` to `localStorage` and applies `[data-theme="dark"]` to `<html>`.

---

## 5. Adversarial Challenge & Stress-Testing

**Overall Risk Assessment:** **MEDIUM**

### Challenge 1: Empty Activity Feed Overwrites Live D1 Dashboard Metrics
- **Assumption Challenged:** Every client with overdue invoices has prior entries in `chase_log`.
- **Attack Scenario:** A newly onboarded agency with 15 overdue invoices loads `index.html`. `d.recentActivity` is empty (`[]`). Because `recentActivity.length > 0` evaluates to `false`, `initOverviewDashboard()` does not return. It falls through to the mock data handler and replaces the real £45,000 overdue balance with mock £6,890.00 data from `DEFAULT_INVOICES`.
- **Blast Radius:** High client confusion and perceived data corruption on new accounts.
- **Mitigation:** Unconditionally return after rendering live metrics in `initOverviewDashboard()`.

### Challenge 2: False Success Feedback on 422/403 Approval Failure
- **Assumption Challenged:** API calls from the review queue always succeed or fail cleanly to offline mock storage.
- **Attack Scenario:** An operator reviews a draft where the debtor email is missing in the database. Clicking "Approve & Send" submits `POST /api/admin/drafts/:id/approve`, which returns HTTP 422 `{"ok":false,"error":"Invoice has no debtor email on file."}`. Because the frontend does not check `res.ok`, the draft card disappears from the queue, a green toast "Approved and dispatched" appears, but no email is ever sent.
- **Blast Radius:** Critical failure of human-in-the-loop audit trail. Overdue invoices remain unchased without the operator knowing.
- **Mitigation:** Check `res.ok` in `window.InvoiceRescue.approveDraft`, display the backend error message on failure, and retain the draft in the queue.

### Challenge 3: In-Place Editing Content Injection (XSS)
- **Assumption Challenged:** Operators or debtors might supply malicious HTML or script tags in draft messages or debtor names.
- **Stress-Test Result:**
  - Tested: `debtor_name = '<script>alert(1)</script>'` and `body = '<img src=x onerror=alert(1)>'`.
  - Result: `dashboard.js` uses `escapeHtml()` during template string rendering and `.textContent = newContent` during DOM mutation. Script tags are strictly escaped to `&lt;script&gt;`. **PASSED (No DOM XSS).**

### Challenge 4: Multi-Tenant Data Isolation
- **Assumption Challenged:** An authenticated client can manipulate query params or payload IDs to view or approve another client's drafts.
- **Stress-Test Result:**
  - Tested: Client 1 session token calling `GET /api/portal/dashboard-data?client_id=2` -> Returns HTTP 403.
  - Tested: Client 1 session token calling `POST /api/admin/drafts/201/approve` where draft 201 belongs to Client 2 -> Returns HTTP 403.
  - Tested: Client 1 calling `PUT /api/admin/drafts/201` -> Returns HTTP 403.
  - Result: Strict multi-tenant boundaries verified. **PASSED.**

---

## 6. Integrity Verification

As required by the Reviewer and Adversarial Critic identity:
1. **Hardcoded Test Results:** No hardcoded results found in `backend/src/lib/portal-api.ts` or `frontend/dashboard/js/dashboard.js`. Dynamic calculations and D1 queries are fully implemented.
2. **Facade Implementations:** Handlers execute real D1 SQL statements, perform HMAC session validation, check tenant boundaries, and dispatch emails via `env.SEND`.
3. **Shortcuts:** Zero external runtime dependencies; all calculations follow UK Late Payment of Commercial Debts Act 1998 specifications.
4. **Attestation Artifacts:** No fabricated test output was found; test logs reflect genuine executions against in-memory D1 SQLite.

---

## 7. Recommended Action Items for Approval

1. **Fix `tests/m3-empirical-challenge.test.ts:442`:** Change `expected: 1853` to `expected: 1854` so that `npm test` passes 100% (420/420 tests).
2. **Fix `frontend/dashboard/js/dashboard.js:625`:** Add an explicit `return;` to prevent empty activity feeds from triggering the mock data fallback.
3. **Fix `frontend/dashboard/js/dashboard.js:1270`:** Add error validation (`if (!res.ok) { ... return; }`) to `window.InvoiceRescue.approveDraft` to prevent phantom dismissals on HTTP 422/403.
4. Re-run `npm test` to confirm green status across all 420 tests.
