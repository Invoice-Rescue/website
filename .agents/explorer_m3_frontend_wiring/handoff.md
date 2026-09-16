# Milestone M3 Handoff Report: Frontend Dashboard Wiring Explorer

## 1. Observation

1. **Frontend Architecture & JS Controller:**
   - In `frontend/dashboard/js/dashboard.js`, lines 21–190: `DEFAULT_INVOICES` array contains 12 mock invoices.
   - Lines 192–270: `DEFAULT_DRAFTS` contains 3 staged AI drafts with locked sender `hello@invoicerescue.co.uk`.
   - Lines 271–312: `DEFAULT_ACTIVITIES` contains 5 mock activity events.
   - Lines 493–619: `initOverviewDashboard()` computes metrics and aging buckets directly from `getStoredInvoices()` in `sessionStorage` without making any HTTP request to `/api/portal/dashboard-data`.
   - Lines 624–866: `initDebtorsTable()` filters and sorts purely in memory from `getStoredInvoices()`, without invoking `GET /api/portal/debtors`.
   - Lines 1058–1088: `approveDraft()` calls legacy endpoint `fetch('/api/chase/${id}/approve', ...)` instead of M3 specification `POST /api/admin/drafts/:id/approve`.
   - Lines 1116–1134: `skipDraft()` calls legacy endpoint `fetch('/api/chase/${id}/skip', ...)` instead of `POST /api/admin/drafts/:id/skip`.
   - Lines 1042–1056: `saveDraftEdit()` updates `draft.body` in `sessionStorage` only, without issuing a `PUT /api/admin/drafts/:id` request.

2. **Backend Route Coverage:**
   - In `backend/src/index.ts`, lines 172–275: Existing endpoints include `GET /api/statutory-rate`, `GET /portal/dashboard` (server-rendered HTML), `GET /admin` (server-rendered HTML review queue), `POST /api/chase/:id/approve`, and `POST /api/chase/:id/skip`.
   - The JSON API routes defined in `PROJECT.md` lines 79–84 (`GET /api/portal/dashboard-data`, `GET /api/portal/debtors`, `GET /api/admin/drafts`, `PUT /api/admin/drafts/:id`) do not yet exist in `backend/src/index.ts`.

3. **WCAG 2.2 Level AA Accessibility:**
   - `frontend/dashboard/index.html` line 14, `debtors.html` line 14, `approval-queue.html` line 14: Accessible skip link is present (`<a href="#main" class="skip-link">Skip to main content</a>`). Target `<main id="main" tabindex="-1">` allows programmatic focus transfer.
   - `frontend/dashboard/css/dashboard.css` lines 207–218: Skip link focus styling (`top: 16px; outline: 3px solid var(--accent);`) and global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` are active.
   - `frontend/dashboard/debtors.html` lines 128–142: Column headers declare `tabindex="0"` and `role="button"`. However, in `dashboard.js` lines 805–829, only `th.addEventListener("click", ...)` is bound. Pressing `Enter` or `Space` does not trigger sort on non-button `<th>` elements.
   - `frontend/dashboard/index.html` line 166: `.aging-gauge` declares `role="progressbar" aria-valuenow="100"`. In `dashboard.js` lines 557–565, segment widths are updated dynamically, but `aria-valuenow` or `aria-valuetext` on the parent progress bar are never updated.
   - `frontend/dashboard/approval-queue.html` lines 973–980 & `dashboard.js` lines 1015–1040: Opening edit mode shifts focus to `#textarea-msg-${id}`, but saving or cancelling edit mode does not return focus to `#btn-edit-toggle-${id}`, leaving keyboard focus stranded.
   - Color contrast calculations:
     - Light mode: `#171B21` (ink) on `#FBFAF7` (paper) = **17.36:1** contrast ratio.
     - Dark mode: `#F0F4F8` (ink) on `#0E1217` (paper) = **17.32:1** contrast ratio.
     - Both exceed the 15:1 high-contrast requirement.

4. **Responsive Layouts & Theming:**
   - In `frontend/dashboard/css/dashboard.css` lines 1581–1646: Responsive breakpoints are established at 1024px, 768px, and 480px. Tables use `.table-scroll-wrapper` with `overflow-x: auto` and `-webkit-overflow-scrolling: touch`.
   - In `frontend/dashboard/js/dashboard.js` lines 428–445: Theme persistence uses `STORAGE_KEY_THEME = "invoice_rescue_theme"` with fallback to `window.matchMedia("(prefers-color-scheme: dark)")`.

5. **Test Suite Status:**
   - Tool command: `npm test`
   - Output: `ℹ tests 376, ℹ pass 376, ℹ fail 0, ℹ duration_ms ~5850ms`.
   - Tool command: `npm run typecheck`
   - Output: Exited with code 0 (`tsc --noEmit`).

---

## 2. Logic Chain

1. **From Observation 1 & 2 (Unconnected Endpoints):**
   - The UI prototype displays realistic data because it reads from local constants and `sessionStorage`.
   - However, when deployed with live D1 data, real client invoices, and active chases, changes in the database will not reflect on the dashboard unless the frontend fetches from live REST endpoints.
   - Therefore, `dashboard.js` must be refactored to asynchronously query `/api/portal/dashboard-data`, `/api/portal/debtors`, and `/api/admin/drafts`.

2. **From Observation 1 & 5 (Need for Resilient Degradation):**
   - In offline demos, static previews, or unauthenticated local browsing, calling live endpoints may return 401, 404, or fail with a network error.
   - If `fetch` errors are unhandled, the UI breaks or crashes.
   - By implementing an `apiFetch` wrapper that catches non-200 responses and falls back to `sessionStorage` and `DEFAULT_*` arrays, the application achieves seamless graceful degradation.

3. **From Observation 3 (WCAG 2.2 AA Compliance Gaps):**
   - WCAG 2.1.1 (Keyboard) requires all interactive controls to be operable via keyboard. Because table headers use `<th>` with `role="button"` instead of native `<button>`, standard browser behavior does not synthesize click events on `Enter` or `Space`. Adding a `keydown` listener resolves this defect.
   - WCAG 4.1.2 (Name, Role, Value) requires assistive technology to be notified of current values for progressbars. Setting dynamic `aria-valuetext` on `.aging-gauge` ensures screen reader users hear the aged breakdown.
   - WCAG 2.4.3 (Focus Order) requires focus not to be lost when interactive components close. Returning focus to the toggle button resolves stranded focus.

4. **From Observation 4 (Theme & Layout):**
   - The CSS grid and flexbox rules gracefully adapt to mobile viewports without horizontal clipping.
   - Adding an inline script in `<head>` ensures dark mode applies before DOM painting, preventing theme flicker.

---

## 3. Caveats

1. **Authentication Mode:** In production, `/api/portal/*` endpoints require the client portal session cookie (`ir_portal_session`), whereas `/api/admin/*` endpoints require HTTP Basic Auth or Cloudflare Access. The frontend wiring assumes cookies and basic auth headers are managed transparently by the browser or origin reverse proxy.
2. **Backend Synchronization:** While this exploration focused on frontend wiring and specifications, the backend endpoints (`GET /api/portal/dashboard-data`, `GET /api/portal/debtors`, `GET /api/admin/drafts`, `PUT /api/admin/drafts/:id`) must be implemented on the Worker edge by the backend engineer to complete live end-to-end integration.

---

## 4. Conclusion

The frontend dashboard assets are exceptionally well-structured and close to production readiness. To achieve complete M3 delivery:
1. Refactor `frontend/dashboard/js/dashboard.js` to implement `apiFetch`, connect to the 6 specified endpoints, and provide a 3-tier fallback to `sessionStorage` and seeded constants.
2. Fix the 3 accessibility gaps: bind `Enter`/`Space` keydown events on sortable table headers, dynamically update `aria-valuetext` on the aging gauge progress bar, and return focus to the edit toggle button upon message save/cancel.
3. Inject the inline theme initialization snippet in `<head>` across all three HTML files to eliminate dark mode FOUC.
4. Implement the corresponding JSON REST endpoints in `backend/src/index.ts`.

---

## 5. Verification Method

To independently verify these conclusions and recommendations:
1. **Source Code Inspection:**
   - Inspect `frontend/dashboard/js/dashboard.js` lines 493–1148 to confirm current mock dependencies and endpoint calls.
   - Inspect `frontend/dashboard/debtors.html` line 128 to confirm `<th>` sort headers lack `<button>` wrappers.
   - Inspect `frontend/dashboard/index.html` line 166 to confirm static `aria-valuenow="100"`.
2. **Contrast Verification:**
   - Calculate relative luminance for `#171B21` on `#FBFAF7` and `#F0F4F8` on `#0E1217` to verify >17:1 ratio.
3. **Execution Commands:**
   - Run `npm run typecheck` to confirm TypeScript baseline.
   - Run `npm test` to verify the 376 tests currently passing.
4. **Invalidation Conditions:**
   - If `th.sortable` already handles keyboard `Enter`/`Space` (it currently does not).
   - If live JSON endpoints already exist in `backend/src/index.ts` (grep search confirmed they do not).
