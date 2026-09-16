# Frontend Dashboard Wiring Exploration Report (Milestone M3: Client Portal & Review Queue)

**Author:** Frontend Dashboard Wiring Explorer  
**Date:** 2026-09-16  
**Target Files:**  
- `frontend/dashboard/js/dashboard.js`  
- `frontend/dashboard/index.html`  
- `frontend/dashboard/debtors.html`  
- `frontend/dashboard/approval-queue.html`  
- `frontend/dashboard/css/dashboard.css`  
- `backend/src/index.ts` (API route additions)  

---

## Executive Summary

This investigation analyzed the frontend dashboard assets in `frontend/dashboard/` and evaluated how to connect the static mock prototype to live backend endpoints while guaranteeing resilient offline/demo fallback capabilities, strict WCAG 2.2 Level AA accessibility compliance, responsive multi-device fidelity, and persistent dark/light theming.

Key discoveries:
1. **API Wiring State:** `frontend/dashboard/js/dashboard.js` currently computes all dashboard metrics and debtor ledger tables entirely in-memory from `sessionStorage` or seeded constant arrays (`DEFAULT_INVOICES`, `DEFAULT_DRAFTS`, `DEFAULT_ACTIVITIES`). The approval queue contains partial calls to legacy endpoint `/api/chase/:id/approve` and `/api/chase/:id/skip`, but does not implement `GET /api/portal/dashboard-data`, `GET /api/portal/debtors`, `GET /api/admin/drafts`, or `PUT /api/admin/drafts/:id`.
2. **Resilience Strategy:** A unified fetch wrapper (`apiFetch`) can gracefully attempt live API calls first, and automatically fall back to session/mock data on network disconnect, 401 unauthenticated, 404 not-yet-implemented, or 500 error responses without throwing unhandled exceptions.
3. **WCAG 2.2 AA Compliance Audit:**
   - **Skip links:** Present and functional (`<a href="#main" class="skip-link">` targeting `<main id="main" tabindex="-1">`).
   - **Keyboard navigability gap:** Table headers (`th.sortable`) in `debtors.html` have `role="button"` and `tabindex="0"`, but only listen for mouse clicks (`click`), ignoring keyboard activation (`Enter` or `Space`).
   - **Screen reader gap:** The aging gauge `.aging-gauge` has `role="progressbar"`, but its `aria-valuenow="100"` is static, lacking dynamic updates or `aria-valuetext` percentages.
   - **Inline edit focus management:** Toggling inline edit does not return focus to the "Edit Message" button upon save or cancellation.
   - **Color Contrast:** The core palette achieves **17.36:1** contrast in light mode (`#171B21` ink on `#FBFAF7` paper) and **17.32:1** in dark mode (`#F0F4F8` ink on `#0E1217` paper), comfortably exceeding the strict 15:1 threshold for primary text.
4. **Theme Persistence:** `localStorage.getItem("invoice_rescue_theme")` is implemented with system dark mode media query fallback. An inline `<head>` script is recommended to eliminate Flash of Unstyled Content (FOUC).

---

## 1. Baseline Architecture & Codebase Analysis

### 1.1 Frontend Structure
The dashboard consists of three static HTML pages, a single unified stylesheet, and a single JavaScript controller:
- `index.html`: Executive overview featuring four KPI cards, a 4-segment aging distribution visual gauge, statutory callout box, and recent activity audit log.
- `debtors.html`: Aged debtor ledger table with debounced search input, stage filter dropdown, status filter dropdown, multi-column sorting headers, results counter, and CSV export.
- `approval-queue.html`: Draft review queue presenting staged AI escalation notices with financial statutory claim breakdown (principal, days overdue, compensation fee, statutory interest, total claim), locked sender verification, in-place editable message body, and Approve/Skip action controls.
- `css/dashboard.css`: 1,647 lines of modern CSS utilizing CSS Custom Properties, Fraunces serif display headings, IBM Plex Sans body text, IBM Plex Mono for tabular financials, responsive grid/flexbox layouts, and high-contrast color tokens.
- `js/dashboard.js`: 1,150 lines encapsulating BoE base rate calculations, statutory interest math, mock datasets, theme initialization, and page-specific setup functions (`initOverviewDashboard`, `initDebtorsTable`, `initApprovalQueue`).

### 1.2 Backend API Baseline (`backend/src/index.ts`)
The current backend routes in `backend/src/index.ts` include:
- `GET /api/statutory-rate`: Returns current BoE base rate.
- `GET /portal/dashboard`: Returns server-rendered HTML for a single client.
- `GET /admin`: Returns server-rendered HTML for the legacy admin review queue.
- `POST /api/chase/:id/approve`: Approves and sends draft via `env.SEND`.
- `POST /api/chase/:id/skip`: Marks draft skipped.

The M3 specification in `PROJECT.md` dictates JSON REST APIs:
- `GET /api/portal/dashboard-data`
- `GET /api/portal/debtors`
- `GET /api/admin/drafts`
- `POST /api/admin/drafts/:id/approve`
- `POST /api/admin/drafts/:id/skip`
- `PUT /api/admin/drafts/:id`

---

## 2. API Integration Specifications & Data Contracts

### 2.1 `GET /api/portal/dashboard-data`
- **Purpose:** Populate executive financial KPI cards, aging gauge segments, and recent activity audit trail on `index.html`.
- **Request:**
  - Method: `GET`
  - URL: `/api/portal/dashboard-data`
  - Headers: `Accept: application/json`
  - Auth: Portal session cookie (`ir_portal_session`) or demo fallback.
- **Response Shape (200 OK):**
```json
{
  "ok": true,
  "client": {
    "id": 1,
    "companyName": "Apex Studio Ltd",
    "plan": "engine"
  },
  "overdueTotals": {
    "totalOverduePence": 4875000,
    "activeChasingPence": 3465000,
    "recoveredMonthPence": 925000,
    "overdueCount": 8
  },
  "agingBreakdown": {
    "bucket1": { "days": "1-7d", "stage": 1, "amountPence": 655000, "count": 3 },
    "bucket2": { "days": "8-14d", "stage": 2, "amountPence": 1160000, "count": 2 },
    "bucket3": { "days": "15-21d", "stage": 3, "amountPence": 890000, "count": 1 },
    "bucket4": { "days": "22d+", "stage": 4, "amountPence": 3155000, "count": 2 }
  },
  "recentActivity": [
    {
      "id": "act-1",
      "type": "sent",
      "title": "Stage 2 Follow-up dispatched",
      "detail": "INV-2026-104 to Meridian Build Partners",
      "amount": "£12,300.00",
      "time": "Today, 08:30"
    }
  ]
}
```
- **DOM Binding:**
  - `#metric-total-overdue`: `formatMoney(totalOverduePence)`
  - `#metric-active-chase`: `formatMoney(activeChasingPence)`
  - `#metric-recovered-month`: `formatMoney(recoveredMonthPence)`
  - `#metric-overdue-count`: `${overdueCount} Invoices`
  - `#gauge-seg-1` through `#gauge-seg-4`: Width percentages calculated from bucket amounts.
  - `#b1-amount` .. `#b4-amount`: Formatted amounts per bucket.
  - `#b1-count` .. `#b4-count`: Overdue count per bucket.
  - `#activity-feed-list`: Rendered activity items.

### 2.2 `GET /api/portal/debtors`
- **Purpose:** Provide debtor ledger items for `debtors.html`.
- **Request:**
  - Method: `GET`
  - URL: `/api/portal/debtors?search=&stage=&status=&sort=days_overdue&dir=desc`
  - Headers: `Accept: application/json`
- **Response Shape (200 OK):**
```json
{
  "ok": true,
  "debtors": [
    {
      "id": 1,
      "invoice_number": "INV-2026-089",
      "debtor_name": "Hartley & Co Ltd",
      "debtor_email": "accounts@hartleyandco.co.uk",
      "amount_pence": 485000,
      "currency": "GBP",
      "due_date": "2026-08-23",
      "days_overdue": 24,
      "stage": 4,
      "stage_label": "Stage 4 (Final)",
      "status": "overdue",
      "last_contact": "2 days ago (Formal Notice)"
    }
  ],
  "total": 12
}
```
- **Client Processing:**
  The frontend loads all client invoices into memory on initialization, executing instant sub-millisecond filtering and sorting locally with debouncing (150ms), or re-fetching if server pagination is configured.

### 2.3 `GET /api/admin/drafts`
- **Purpose:** Populate review queue cards in `approval-queue.html`.
- **Request:**
  - Method: `GET`
  - URL: `/api/admin/drafts`
  - Headers: `Accept: application/json`
- **Response Shape (200 OK):**
```json
{
  "ok": true,
  "drafts": [
    {
      "id": 101,
      "invoice_id": 1,
      "invoice_number": "INV-2026-089",
      "debtor_name": "Hartley & Co Ltd",
      "debtor_email": "accounts@hartleyandco.co.uk",
      "company_name": "Apex Studio Ltd",
      "amount_pence": 485000,
      "currency": "GBP",
      "days_overdue": 24,
      "step": 4,
      "step_label": "Stage 4 (Final Notice)",
      "subject": "FINAL DEMAND — Overdue Invoice INV-2026-089 (Hartley & Co Ltd)",
      "body": "Dear Accounts Team...\n\nYours sincerely,\nTibor Rames\nInvoice Rescue — on behalf of Apex Studio Ltd",
      "locked_sender": "hello@invoicerescue.co.uk",
      "fixed_compensation_pence": 7000,
      "statutory_interest_pence": 3747,
      "total_claim_pence": 495747
    }
  ]
}
```

### 2.4 Action Endpoints (`approve`, `skip`, `PUT edit`)
1. **`POST /api/admin/drafts/:id/approve`**:
   - Request Body: `{"body": "<edited or original text>"}` (or `x-www-form-urlencoded`)
   - Fallback: `/api/chase/:id/approve`
   - Response: `{"ok": true}`
2. **`POST /api/admin/drafts/:id/skip`**:
   - Request Body: empty
   - Fallback: `/api/chase/:id/skip`
   - Response: `{"ok": true}`
3. **`PUT /api/admin/drafts/:id`**:
   - Request Body: `{"body": "<updated message text>"}`
   - Response: `{"ok": true, "draft": {...}}`

---

## 3. Resilient Offline & Demo Degradation Strategy

To ensure zero downtime, preview reliability, and developer experience:
1. **3-Tier Fallback Cascade:**
   - **Tier 1 (Live API):** Call API with `Accept: application/json`. If status 200..299, deserialize JSON and persist fresh snapshot to `sessionStorage`.
   - **Tier 2 (Session Snapshot):** If the API returns non-200 or throws a network error (e.g., Worker offline, CORS in preview, unauthenticated demo), check `sessionStorage` for user edits made during the current browser session.
   - **Tier 3 (Constant Defaults):** If `sessionStorage` is empty, initialize with `DEFAULT_INVOICES`, `DEFAULT_DRAFTS`, and `DEFAULT_ACTIVITIES`.
2. **Optimistic UI Mutations:**
   - In `approveDraft`: Disable the button, display a loading spinner (`⏳ Sending...`). Dispatch API call. Whether the call succeeds or hits a mock environment (404/offline), remove the draft from local memory, save to `sessionStorage`, prepend an activity log item, update the debtor record's `last_contact` timestamp, update the header count badge, and display a confirmation toast.
   - In `skipDraft`: Call skip API. Remove from local list and display a skip toast.
   - In `saveDraftEdit`: Call `PUT` endpoint. Save changes to local state, update character count, switch view mode back to preview, and show a success toast.

---

## 4. WCAG 2.2 Level AA Accessibility Audit & Remediation

### 4.1 Skip Links & Focus Anchoring
- **Status:** PASS (with verification)
- **Code:** `<a href="#main" class="skip-link">Skip to main content</a>`
- **Location:** Line 14 on all three HTML files.
- **CSS:**
  - Standard state: `position: absolute; top: -60px; left: 20px;`
  - Focused state: `:focus { top: 16px; outline: 3px solid var(--accent); outline-offset: 2px; }`
  - Target: `<main id="main" tabindex="-1">` ensures focus moves directly to the primary container without keyboard trap or broken scroll.

### 4.2 Keyboard Navigability & Table Sort Header Gap
- **Status:** REMEDIATION REQUIRED
- **Issue:** In `debtors.html`, sortable column headers are coded as:
  `<th scope="col" class="sortable" data-sort="debtor_name" tabindex="0" role="button">`
  In `dashboard.js`, sorting is attached via:
  `sortHeaders.forEach(th => th.addEventListener("click", ...))`
  In standard browsers, pressing `Enter` or `Space` on a `<th>` element does NOT synthesize a `click` event (unlike native `<button>` elements). Keyboard-only and screen reader users cannot activate sorting.
- **Remediation:** Add a `keydown` listener to all `.sortable` headers in `dashboard.js`:
```javascript
th.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    th.click();
  }
});
```

### 4.3 Screen Reader Labels & Dynamic ARIA Attributes
- **Status:** REMEDIATION REQUIRED
- **Issues Identified:**
  1. Aging Gauge Progressbar: Line 166 of `index.html` specifies:
     `<div class="aging-gauge" role="progressbar" aria-label="Aged debt distribution percentage" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100">`
     In `dashboard.js`, segment widths are dynamically adjusted, but `aria-valuenow` and `aria-valuetext` are never updated on the progress bar container. Screen readers announce a static 100% without cadence context.
     *Remediation:* Update `aria-valuetext` during gauge rendering:
     ```javascript
     const gauge = document.querySelector(".aging-gauge");
     if (gauge) {
       gauge.setAttribute("aria-valuetext", `Stage 1: ${p1}%, Stage 2: ${p2}%, Stage 3: ${p3}%, Stage 4: ${p4}%`);
     }
     ```
  2. Inactive Sort Headers: When one column is sorted, inactive sort headers currently remove `aria-sort`.
     *Remediation:* Set `aria-sort="none"` on inactive sortable headers per W3C APG guidelines.
  3. Live Region on Table Results: `#table-results-count` has `aria-live="polite"`. Ensure debtor count changes are announced clearly.

### 4.4 Focus Management in Inline Message Editing
- **Status:** REMEDIATION REQUIRED
- **Issue:** When the operator clicks "Edit Message", focus moves to `#textarea-msg-${id}` (Line 1033). However, when the operator clicks "Save Edit" or "Cancel Edit", focus is left stranded inside the hidden container.
- **Remediation:** Explicitly restore focus to `#btn-edit-toggle-${id}` upon closing edit mode:
```javascript
const toggleBtn = document.getElementById(`btn-edit-toggle-${id}`);
if (toggleBtn) toggleBtn.focus();
```

### 4.5 High-Contrast Audit (>15:1 Ratio Analysis)
- **Light Mode Palette:**
  - Paper: `#FBFAF7` (Luminance L1 ≈ 0.957)
  - Ink: `#171B21` (Luminance L2 ≈ 0.008)
  - **Contrast Ratio:** `(0.957 + 0.05) / (0.008 + 0.05) = 1.007 / 0.058 = 17.36:1` (Exceeds 15:1 requirement).
- **Dark Mode Palette:**
  - Paper: `#0E1217` (Luminance L2 ≈ 0.005)
  - Ink: `#F0F4F8` (Luminance L1 ≈ 0.903)
  - **Contrast Ratio:** `(0.903 + 0.05) / (0.005 + 0.05) = 0.953 / 0.055 = 17.32:1` (Exceeds 15:1 requirement).
- **Focus Rings:**
  - Light mode focus ring: `--accent` (`#C1620E`), outline 2px solid with 2px offset.
  - Dark mode focus ring: `--rule-focus` (`#E07A22`).
  - Both contrast sharply against their respective card backgrounds (>3:1 non-text contrast requirement).

---

## 5. Responsive Design & Theme Persistence

### 5.1 Viewport Breakpoints
`dashboard.css` contains structured media queries ensuring layout fidelity:
- **Desktop (>1024px):** 4-column metric grid; 2-column split (Aging chart left, Activity feed right); 5-column financial claim ribbon.
- **Tablet (769px–1024px):** 2-column metric grid; single-column stacked overview; 3-column claim ribbon.
- **Mobile (≤768px):** Single-column metrics; stacked filter toolbar; vertical action buttons in draft cards; horizontal touch-scrollable navigation bar (`overflow-x: auto`).
- **Debtor Table Scroll:** The table is wrapped in `<div class="table-scroll-wrapper">` with `overflow-x: auto` and `-webkit-overflow-scrolling: touch`, preventing table columns from crushing on small viewports.

### 5.2 Theme Persistence & Anti-FOUC
- **Storage Key:** `STORAGE_KEY_THEME = "invoice_rescue_theme"`.
- **Mechanism:** On load, inspects `localStorage`. If absent, defaults to `window.matchMedia("(prefers-color-scheme: dark)")`.
- **Toggle Action:** Clicking `#theme-toggle-btn` toggles `data-theme` attribute between `"dark"` and `"light"`, saves to `localStorage`, and swaps the SVG icon and aria-label.
- **FOUC Prevention Recommendation:** To prevent a white flash when a dark-mode user opens the portal, insert this script directly inside `<head>` of all three pages:
```html
<script>
  (function() {
    const saved = localStorage.getItem("invoice_rescue_theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", saved || (prefersDark ? "dark" : "light"));
  })();
</script>
```

---

## 6. Implementation Code Blueprint for the Worker

### 6.1 Required Refactor in `frontend/dashboard/js/dashboard.js`
The following components should be upgraded in `dashboard.js`:
1. Add `apiFetch` helper:
```javascript
async function apiFetch(endpoint, options = {}) {
  try {
    const res = await fetch(endpoint, {
      headers: {
        "Accept": "application/json",
        ...(options.headers || {})
      },
      ...options
    });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err, data: null };
  }
}
```
2. Refactor `initOverviewDashboard`:
   - Query `/api/portal/dashboard-data`.
   - Update cards, aging gauge, and activity feed.
   - Update `aria-valuetext` on `.aging-gauge`.
   - Fall back to stored invoices if offline/error.
3. Refactor `initDebtorsTable`:
   - Query `/api/portal/debtors`.
   - Add keyboard `Enter`/`Space` listeners to `th.sortable`.
   - Update `aria-sort` correctly (`"none"`, `"ascending"`, `"descending"`).
4. Refactor `initApprovalQueue`:
   - Query `/api/admin/drafts`.
   - In `saveDraftEdit`: call `PUT /api/admin/drafts/:id`.
   - In `approveDraft`: call `POST /api/admin/drafts/:id/approve` (fallback to `/api/chase/:id/approve`).
   - In `skipDraft`: call `POST /api/admin/drafts/:id/skip` (fallback to `/api/chase/:id/skip`).
   - Manage keyboard focus when entering and exiting edit mode.

### 6.2 Required Backend Route Additions in `backend/src/index.ts`
To fulfill the M3 contract, the following endpoints should be added to `backend/src/index.ts`:
1. `GET /api/portal/dashboard-data`: Returns JSON aggregated metrics, aging buckets, and recent activity for the authenticated client.
2. `GET /api/portal/debtors`: Returns JSON list of debtor invoices with filtering and sorting support.
3. `GET /api/admin/drafts`: Returns JSON list of staged drafts with full statutory breakdown.
4. `POST /api/admin/drafts/:id/approve`: Approves draft and dispatches email via `env.SEND`.
5. `POST /api/admin/drafts/:id/skip`: Sets draft status to skipped.
6. `PUT /api/admin/drafts/:id`: Updates draft message body.

---

## 7. Verification & Testing Plan

1. **Automated Suite:** Run `npm test` to verify zero regressions across the 376 existing unit and integration tests.
2. **Type Check:** Run `npm run typecheck` to verify TypeScript compile integrity.
3. **Build Dry-Run:** Run `npm run build` (`wrangler deploy --dry-run`) to verify asset bundling.
4. **Manual & Browser QA Verification:**
   - Verify keyboard tab order through skip link, nav items, search input, filter selects, and table sort headers.
   - Verify pressing `Enter` and `Space` on table headers triggers column sorting and updates `aria-sort`.
   - Verify theme toggle switches between dark and light, persists in `localStorage`, and updates `aria-label`.
   - Verify draft approval removes the draft card, increments recent activity, and updates the navigation badge.
   - Verify offline behavior by disabling network in browser dev tools: dashboard must render seamlessly with seeded mock data.
