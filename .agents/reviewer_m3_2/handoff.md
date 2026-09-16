# Handoff Report: Reviewer 2 (Milestone M3 Review & Adversarial Challenge)

**Author:** Reviewer 2 (`reviewer_m3_2`)  
**Milestone:** M3 (Client Portal & Review Queue - R3)  
**Date:** 2026-09-16T13:34:00Z  
**Type:** Hard Handoff (Review Complete)  
**Verdict:** **REQUEST_CHANGES**

---

## 1. Observation

1. **Quality Gates Execution Results:**
   - **Gate 1 (`npx tsc --noEmit`)**: Exited with code 0 (0 errors) at 2026-09-16T12:30:52Z.
   - **Gate 2 (`npm test`)**: Exited with **code 1** at 2026-09-16T12:31:02Z:
     ```
     ✖ 3.2 Statutory interest calculation produces exact pence with zero rounding drift across multiple BoE rates and periods (2.6132ms)
       AssertionError [ERR_ASSERTION]: Statutory interest mismatch for £6400.00 overdue 9d at 3.75% BoE: got 1854, expected 1853
       1854 !== 1853
           at TestContext.<anonymous> (D:\Dev\Workspaces\Active\invoice-rescue\tests\m3-empirical-challenge.test.ts:460:16)
     ℹ tests 420
     ℹ suites 87
     ℹ pass 419
     ℹ fail 1
     ```
   - **Gate 3 (`npm run build`)**: Exited with code 0 (`wrangler deploy --dry-run` bundled 20 assets, 118.46 KiB total) at 2026-09-16T12:31:32Z.
   - **Gate 4 (`npx wrangler d1 migrations apply invoice-rescue-db --local`)**: Exited with code 0 ("✅ No migrations to apply!") at 2026-09-16T12:31:41Z.

2. **Dedicated Portal Test Suite (`tests/portal-endpoints.test.ts`)**:
   - `node --test --import tsx tests/portal-endpoints.test.ts` passed 27 of 27 tests across 7 suites with 0 failures.

3. **Frontend Dashboard Code (`frontend/dashboard/js/dashboard.js`)**:
   - In `initOverviewDashboard()`, lines 593–628:
     ```javascript
     const activityFeed = document.getElementById("activity-feed-list");
     if (activityFeed && Array.isArray(d.recentActivity) && d.recentActivity.length > 0) {
       activityFeed.innerHTML = d.recentActivity
         .map(...)
         .join("");
       return;
     }
     // 2. Fallback to session / mock data
     const invoices = getStoredInvoices();
     ```
     Line 623 contains `return;` nested inside the `if` block checking `d.recentActivity.length > 0`. If `d.recentActivity` is empty (`[]`), the function fails to return and falls through to line 627, overwriting live D1 metrics with `DEFAULT_INVOICES` mock figures on lines 671–722.
   - In `approveDraft()`, lines 1261–1284:
     ```javascript
     try {
       let res = await apiFetch(`/api/admin/drafts/${id}/approve`, ...);
       if (!res.ok && res.status === 404) { ... }
     } catch (err) { ... }
     // Remove from drafts list
     drafts = drafts.filter((d) => d.id !== id);
     saveStoredDrafts(drafts);
     showToast(`Approved and dispatched chase message for ${draft.debtor_name}`);
     ```
     `approveDraft` unconditionally removes the draft and displays a success toast even if the backend returns HTTP 422 (e.g. debtor email missing) or HTTP 403 (forbidden).

4. **WCAG 2.2 Level AA Compliance:**
   - `th.sortable` in `dashboard.js` lines 986–991 handles `Enter` and `Space` keydown events.
   - `.aging-gauge[role="progressbar"]` dynamically updates `aria-valuetext` (lines 567–571 and 698–702).
   - Edit mode cancel/save explicitly calls `toggleBtn.focus()` (`#btn-edit-toggle-${draft.id}`), restoring focus (lines 1202, 1245).
   - Color contrast: light mode `#171B21` on `#FBFAF7` is 17.34:1; dark mode `#F0F4F8` on `#0E1217` is 17.09:1 (both > 15:1).

---

## 2. Logic Chain

1. **Gate 2 Failure:**
   - Observation 1 demonstrates that `npm test` fails with 1 test failure out of 420.
   - Tracing the failure in `tests/m3-empirical-challenge.test.ts:460`: for £6,400.00 overdue 9 days at 3.75% BoE rate (statutory rate 11.75%), `Math.round(((640000 * 11.75) / 100 / 365) * 9) = Math.round(1854.2465...) = 1854`.
   - The production implementation in `backend/src/lib/statutory-interest.ts` is mathematically correct.
   - However, the test file has `expected: 1853` on line 442, causing `npm test` to exit with code 1.
   - By definition, an M3 release candidate cannot be approved while `npm test` fails.

2. **Frontend Metric Overwrite Bug:**
   - Observation 3 shows that `return;` is placed inside `if (activityFeed && Array.isArray(d.recentActivity) && d.recentActivity.length > 0)`.
   - Any client that has zero recent activities will bypass this `if` block, fall into the mock session fallback, and display fabricated mock totals (`DEFAULT_INVOICES`) instead of their live D1 totals.
   - This causes an active functional defect in production client onboarding.

3. **Silent Queue Approval Failure Bug:**
   - Observation 3 shows that `approveDraft` does not verify `res.ok`.
   - When an approval request is rejected by the backend with HTTP 422 or 403, the UI falsely indicates success and clears the draft from the queue.
   - This breaks the core human-in-the-loop guarantee of Requirement R3.

---

## 3. Caveats

- The root cause of the `npm test` failure is an arithmetic typo inside `tests/m3-empirical-challenge.test.ts`, rather than a defect in `backend/src/lib/statutory-interest.ts`.
- The dedicated M3 unit/integration test suite `tests/portal-endpoints.test.ts` passes 27/27 tests cleanly.
- No other caveats.

---

## 4. Conclusion

The implementation of Milestone M3 is structurally robust, with strict tenant isolation, zero external runtime dependencies, accurate statutory calculation logic, and compliant WCAG 2.2 AA accessibility features.

However, because:
1. Quality Gate 2 (`npm test`) fails with exit code 1,
2. An empty activity feed erroneously triggers the mock data overwrite in `dashboard.js`, and
3. Draft approval lacks backend error handling and optimistic UI rollback,

the official verdict is **REQUEST_CHANGES**.

---

## 5. Verification Method

To independently verify these findings and confirm their resolution:

1. **Verify Quality Gate Failure:**
   ```powershell
   npm test
   ```
   *Expected behavior:* Exits with code 1, showing failure at `tests/m3-empirical-challenge.test.ts:460`.

2. **Verify Frontend Logic Fixes:**
   - Inspect `frontend/dashboard/js/dashboard.js` line 625: verify an unconditional `return;` is present following live API metric rendering.
   - Inspect `frontend/dashboard/js/dashboard.js` line 1265: verify `if (!res.ok) { ... return; }` guards local queue mutations and displays error toasts.

3. **Verify Green Suite After Fixes:**
   ```powershell
   npx tsc --noEmit
   npm test
   npm run build
   npx wrangler d1 migrations apply invoice-rescue-db --local
   ```
   *Expected behavior:* All 4 quality gates exit code 0 with 420/420 tests passing.
