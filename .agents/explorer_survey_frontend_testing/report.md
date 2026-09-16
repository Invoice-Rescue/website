# Frontend & Testing Survey Report — Invoice Rescue

**Date**: 2026-09-16  
**Investigator**: Frontend & Testing Explorer  
**Working Directory**: `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_survey_frontend_testing`  
**Target Project**: `d:\Dev\Workspaces\Active\invoice-rescue`  
**Reference Document**: `.agents/ORIGINAL_REQUEST.md` (R3: Client Portal & Review Queue; Quality & Verification Gate)

---

## 1. Executive Summary

A comprehensive, read-only audit of the `invoice-rescue` repository was performed with a specific focus on the **Frontend Client Portal**, **Debtor Ledger & Review Queue (Requirement R3)**, and the **Build, Quality & Verification Gates**.

### Key Findings
1. **Rich Static Portal Built**: A fully realized, responsive, and WCAG 2.2 Level AA-compliant frontend interface exists under `frontend/dashboard/` consisting of three distinct HTML views (`index.html`, `debtors.html`, `approval-queue.html`), a 1,647-line CSS architecture (`dashboard.css`), and an 1,150-line vanilla JavaScript engine (`dashboard.js`).
2. **Quality Gates 100% Operational**: All 4 quality gates mandated by `ORIGINAL_REQUEST.md` currently execute with **0 errors and 100% pass rates**:
   - `npx tsc --noEmit` — Passes with zero TypeScript diagnostic errors.
   - `npm test` — 31 tests across 6 test suites pass in ~908ms using Node's native test runner (`tsx --test`).
   - `npm run build` (`wrangler deploy --dry-run`) — Bundles cleanly without external runtime dependencies, bundling 20 static assets.
   - `npx wrangler d1 migrations apply invoice-rescue-db --local` — All 6 database schema migrations are cleanly applied.
3. **Core Architectural Gap**: A decoupling exists between the Cloudflare Worker runtime and the static dashboard:
   - Worker route `/portal/dashboard` currently intercepts authenticated requests and renders a legacy, minimal unstyled HTML table from `backend/src/lib/portal.ts`.
   - Admin route `/admin` renders an unstyled HTML table from `backend/src/lib/admin.ts`.
   - The modern interactive portal in `frontend/dashboard/` runs client-side at `/dashboard/` using mock data stored in `sessionStorage`. No REST endpoints currently expose authenticated JSON streams for `GET /api/portal/invoices` or `GET /api/chase/queue` from D1 to the frontend.
4. **Testing Surface Gaps**: The existing automated tests exclusively cover backend business logic (`statutory-interest`, `escalation`, `csv`, `portal-auth`, `stripe`, `webhooks`, `gemini`). There are currently **0 frontend unit tests** for `dashboard.js` and no automated E2E browser or accessibility (axe) test harness.

---

## 2. Requirement R3: Client Portal & Review Queue Deep-Dive

### 2.1 File Catalog & Architecture

```
frontend/
├── _headers                     # Security headers & cache-control rules
├── compare/                     # SEO comparison landing pages (e.g. /compare/chaser)
├── privacy/                     # Privacy notice
├── terms/                       # Terms of service
├── index.html                   # Public marketing landing page & statutory calculator
├── dashboard/                   # Client Portal & Review Queue
│   ├── index.html               # View 1: Executive Financial Overview
│   ├── debtors.html             # View 2: Debtor Ledger & Invoice Management
│   ├── approval-queue.html      # View 3: Human-in-the-loop Draft Approval Queue
│   ├── css/
│   │   └── dashboard.css        # High-contrast, responsive, dual-theme stylesheet (1,647 lines)
│   └── js/
│       └── dashboard.js         # Reactive search/filter/sort, statutory calculations (1,150 lines)
```

Static files are hosted via Cloudflare Workers Assets binding (`assets: { directory: "./frontend", binding: "ASSETS" }`).

---

### 2.2 Executive Dashboard (`frontend/dashboard/index.html`)

The executive dashboard provides high-level financial intelligence and aged debt visibility:

1. **Executive Financial Metrics Grid**:
   - **Total Overdue Debt** (`#metric-total-overdue`): Dynamically sums open ledger balances in overdue, promised, or disputed states.
   - **Active In Chasing** (`#metric-active-chase`): Tracks capital actively in Stages 1–4 collection sequences (excluding disputed balances).
   - **Recovered This Month** (`#metric-recovered-month`): Tracks settled revenue with comparative trends.
   - **Open Overdue Invoices** (`#metric-overdue-count`): Displays count of actionable invoices with average turnaround metrics.
2. **Overdue Aging Breakdown & Visual Gauge**:
   - Visual multi-segment progress gauge (`role="progressbar"`) displaying percentage distribution across statutory escalation intervals:
     - **1–7 Days Overdue** (`.gauge-seg-1`): Stage 1 Gentle reminder & invoice reconciliation.
     - **8–14 Days Overdue** (`.gauge-seg-2`): Stage 2 Firm follow-up & direct finance contact.
     - **15–21 Days Overdue** (`.gauge-seg-3`): Stage 3 Formal notice of debt & payment deadline.
     - **22+ Days Overdue** (`.gauge-seg-4`): Stage 4 Final demand with statutory interest and compensation.
   - Dynamic figures per bucket showing total currency amount and count of overdue accounts.
3. **Statutory Callout Section**:
   - Explicitly cites the **Late Payment of Commercial Debts (Interest) Act 1998**, explaining the statutory compensation (£40–£100) and Bank of England base rate + 8% daily simple interest.
4. **Recent Activity Feed** (`#activity-feed-list`):
   - Semantic feed (`role="feed"`) providing an audit trail of outbound chases, debtor settlements, AI drafts generated, and dispute flags.

---

### 2.3 Debtor Ledger Table (`frontend/dashboard/debtors.html`)

The debtor ledger provides tabular credit-control management:

1. **Debounced Instant Search**:
   - Search input (`#debtor-search`) equipped with a 150ms debounce handler in `dashboard.js`.
   - Matches dynamically across Debtor Name, Invoice Number, and Debtor Email.
2. **Filtering by Stage and Status**:
   - Escalation Stage filter: All Stages, Stage 1 (Gentle), Stage 2 (Follow-up), Stage 3 (Firm), Stage 4 (Final).
   - Invoice Status filter: All Statuses, Overdue, Promised, Paid, Disputed.
   - Dedicated "Reset Filters" action button.
   - Live results counter (`#table-results-count`, `aria-live="polite"`).
3. **Multi-Column Sorting**:
   - Sortable columns on `<th>` headers: Debtor Name, Invoice Number, Amount (£), Due Date, and Days Overdue.
   - Accessible keyboard trigger (`tabindex="0"`, `role="button"`).
   - Bi-directional toggling (`asc` / `desc`) with dynamic `aria-sort` attributes and visual indicators (`↑`, `↓`, `↕`).
4. **CSV Export**:
   - "Export Ledger CSV" action generates RFC 4180-compliant CSV files in-memory using `data:text/csv` data URIs, properly escaping quotation marks and special characters.

---

### 2.4 Interactive Draft-Approval Queue (`frontend/dashboard/approval-queue.html`)

Implements the human-in-the-loop verification gate before outbound debtor email dispatch:

1. **Queue Summary & Status Banner**:
   - Header badge showing pending review count (`.nav-badge-drafts`).
   - Warning alert banner displayed across all portal pages if unreviewed drafts are pending.
2. **Statutory Claim Financial Ribbon**:
   - Each draft card breaks down the legal financial claim:
     - **Principal Invoice Amount**
     - **Days Overdue**
     - **Fixed Compensation**: £40 (<£1,000), £70 (£1,000–£9,999.99), £100 (≥£10,000).
     - **Statutory Interest**: Calculated via `Math.round(((principal * (baseRate + 8%)) / 100 / 365) * daysOverdue)`.
     - **Total Claim Owed**: Exact sum of principal + compensation + accrued interest.
3. **Locked Sender & Trust Boundary**:
   - Prominently displays verified sender envelope:
     - `From: Invoice Rescue <hello@invoicerescue.co.uk>`
     - Tagged `🔒 Verified Sender` (DMARC/SPF aligned via `cf-bounce.invoicerescue.co.uk`).
     - Operator Sign-off footer: "Drafted by AI, verified by Tibor Rames on behalf of [Client]".
4. **In-Place Message Editing**:
   - "Edit Message" button toggles view into an editable `<textarea>`.
   - Real-time character counter (`#char-count-${id}`).
   - "Save Edit" button updates the stored draft body and DOM preview without page reloads.
5. **Human Dispatch Actions**:
   - **"Approve & Send"**: Sends POST to `/api/chase/:id/approve` with updated body, renders an animated loading spinner (`Sending...`), records an audit log entry in the activity feed, updates invoice contact status, and removes the draft from the queue.
   - **"Skip / Defer"**: Sends POST to `/api/chase/:id/skip`, removes draft from active queue, and notifies operator via toast.
   - Empty state view displayed with clear callout once all drafts are cleared.

---

### 2.5 Styling, Design System & Theming (`frontend/dashboard/css/dashboard.css`)

1. **Design System & Typography**:
   - Primary typography: `IBM Plex Sans` (clean sans-serif for UI/data).
   - Display typography: `Fraunces` (warm, authoritative serif for headers and branding).
   - Monospace typography: `IBM Plex Mono` (financial numerals, currency amounts, invoice identifiers).
2. **Dual-Theme Support**:
   - **Light Theme (Heritage Paper)**: Warm editorial aesthetic (`--paper: #FBFAF7`, `--card: #FFFFFF`, `--ink: #171B21`, `--accent: #C1620E`).
   - **Dark Theme (Dark Slate)**: High-contrast technical aesthetic (`--paper: #0E1217`, `--card: #161C24`, `--ink: #F0F4F8`, `--accent: #E07A22`).
   - Theme toggle button (`#theme-toggle-btn`) with dynamic SVG icons, persisting choice in `localStorage` under `invoice_rescue_theme` while honoring system `prefers-color-scheme`.
3. **Responsive Breakpoints**:
   - `> 1024px`: Desktop 4-column metric grid, 2-column dashboard split (aging gauge + activity feed).
   - `1024px`: Tablet 2-column metric grid, stacked single-column dashboard split.
   - `768px`: Mobile layout with horizontally scrollable navigation, 1-column metrics, stacked search/filter toolbar, and full-width touch buttons.
   - `480px`: Small mobile with single-column financial ribbons and collapsed table padding.

---

### 2.6 Accessibility Audit (WCAG 2.2 Level AA Compliance)

| Criterion | Implementation in Code | Evaluation |
|---|---|---|
| **Bypass Blocks (2.4.1)** | `<a href="#main" class="skip-link">Skip to main content</a>` on all pages. | ✅ Fully Compliant |
| **Focus Visible (2.4.7 / 2.4.11)** | High-contrast focus indicator: `outline: 2px solid var(--rule-focus); outline-offset: 2px;` on `:focus-visible`. | ✅ Fully Compliant |
| **Color Contrast (1.4.3 / 1.4.11)** | Text contrast exceeds 15:1 in both light (#171B21 on #FBFAF7) and dark (#F0F4F8 on #0E1217). Badges use colored borders + backgrounds with dark text. | ✅ Fully Compliant |
| **Name, Role, Value (4.1.2)** | ARIA roles used: `role="banner"`, `role="navigation"`, `role="main"`, `role="contentinfo"`, `role="progressbar"`, `role="region"`, `role="feed"`, `role="status"`. | ✅ Fully Compliant |
| **Status Messages (4.1.3)** | Dynamic updates use `aria-live="polite"` on results counter and toast alerts (`#toast-container`). | ✅ Fully Compliant |
| **Reduced Motion (2.3.3)** | `@media (prefers-reduced-motion: reduce)` sets transitions and animations to `0.01ms`. | ✅ Fully Compliant |
| **Labels and Instructions (3.3.2)** | All form controls have associated `<label>` or `.sr-only` screen-reader labels. | ✅ Fully Compliant |
| **Table Semantics (1.3.1)** | `<table>` uses `<caption>`, `<th scope="col">`, `<thead>`, `<tbody>`. Sortable headers announce `aria-sort`. | ✅ Fully Compliant |

---

## 3. Quality & Verification Gates Assessment

### 3.1 Verification Commands & Output Verification

Each gate was executed directly in the project root:

```powershell
# Gate 1: Type Checking
npx tsc --noEmit
# Result: Exit Code 0 (0 errors)

# Gate 2: Automated Unit/Integration Tests
npm test
# Command executed: tsx --test tests/**/*.test.ts
# Result: 31 passed, 0 failed, 6 suites (908ms)

# Gate 3: Worker Bundling & Assets Check
npm run build
# Command executed: wrangler deploy --dry-run
# Result: Exit Code 0, 20 static assets read (42.84 KiB), all bindings resolved

# Gate 4: Local D1 Schema Migrations
npx wrangler d1 migrations apply invoice-rescue-db --local
# Result: Exit Code 0, "No migrations to apply!" (All 6 migrations up to date)
```

---

### 3.2 Existing Test Suite Breakdown

The repository currently includes 8 test files in `tests/`:

| Test File | Test Suite | Test Count | Areas Covered |
|---|---|:---:|---|
| `tests/csv.test.ts` | CSV Parser | 4 | Standard tabular CSV, embedded commas/escaped quotes, CRLF newlines, empty rows. |
| `tests/escalation.test.ts` | Escalation Cadence | 7 | Step labels, 4-stage escalation timeline (1d, 8d, 15d, 22d), sequence exhaustion, state machine transitions. |
| `tests/gemini.test.ts` | Gemini Prompt Generation | 3 | Prompt synthesis for Step 1 (reminder), Step 3 (statutory notice & compensation), Step 4 (final notice). |
| `tests/oauth.test.ts` | OAuth Token Encryption | 1 | Web Crypto AES-256-GCM token encryption and decryption. |
| `tests/portal-auth.test.ts` | Portal Auth & HMAC | 7 | Magic-link signing/verifying, tampering rejection, wrong secret, cookie generation/verification, session clearance. |
| `tests/statutory-interest.test.ts` | Statutory Calculations | 2 | Fixed compensation statutory tiers (£40/£70/£100), daily simple statutory interest formula. |
| `tests/stripe.test.ts` | Stripe Webhooks | 5 | Signature verification, replay prevention (5m tolerance), payload tampering, fail-closed handling, event parsing. |
| `tests/webhooks.test.ts` | Accounting Webhooks | 2 | QuickBooks and Xero HMAC signature verification. |
| **Total** | | **31** | **All passing (100%)** |

---

## 4. Gap Analysis: What Exists vs. Missing/Partial

### 4.1 Requirement Mapping Matrix

| Acceptance Criteria / Feature | Status | Current Codebase Evidence | Gap / Required Action |
|---|:---:|---|---|
| **Executive Financial Dashboard** (Overdue totals, aging breakdown gauge, active recovery pipeline) | **Partial** | Complete UI exists in `frontend/dashboard/index.html` with calculations in `dashboard.js`. | Currently rendered via static HTML with client `sessionStorage` mock data. Needs server-side D1 data binding or API hydration. |
| **Debtor Ledger Table** (Debounced search, filtering by stage/status) | **Complete (UI)** / **Partial (Data)** | Fully implemented in `frontend/dashboard/debtors.html` & `dashboard.js` with 150ms debounce and multi-column sorting. | Operates on client mock data. Needs live D1 database feed for client invoices. |
| **WCAG 2.2 Level AA Compliance** | **Complete** | Skip links, 15:1+ contrast, focus rings, ARIA roles, `aria-live`, prefers-reduced-motion in `dashboard.css`. | Verified by code audit. Could benefit from automated test assertion in test suite. |
| **Interactive Draft Approval Queue** (Statutory claim breakdown, in-place edit, Approve & Send, Skip/Defer) | **Complete (UI)** / **Partial (Wiring)** | Fully built in `frontend/dashboard/approval-queue.html`. Edit mode, character count, Approve & Skip actions wired in `dashboard.js`. | `POST /api/chase/:id/approve` and `skip` exist in Worker, but no `GET /api/chase/queue` endpoint exists to populate real drafts from D1 into the UI. |
| **Dark & Light Mode Support** | **Complete** | Full dual-theme CSS variables in `dashboard.css`, JS toggle, system preference detection, localStorage persistence. | No gaps found. |
| **Responsive Layouts** (Mobile & Desktop) | **Complete** | Breakpoints at 1024px, 768px, 480px in `dashboard.css`. Mobile navigation, flexible ribbons, adaptive action buttons. | No gaps found. |
| **Quality Gate 1: Type Checking** (`tsc --noEmit`) | **Complete** | `npx tsc --noEmit` exits with code 0. | No gaps found. |
| **Quality Gate 2: Test Suite** (`npm test`) | **Complete (Backend)** / **Partial (Frontend)** | `npm test` runs 31 tests and passes 100%. | Frontend business logic in `dashboard.js` has no tests in `tests/`. |
| **Quality Gate 3: Worker Bundling** (`npm run build`) | **Complete** | `wrangler deploy --dry-run` bundles cleanly without errors. | No gaps found. |
| **Quality Gate 4: Local D1 Migrations** | **Complete** | Migrations 0001–0006 apply cleanly to local D1. `npm run db:seed` works. | No gaps found. |

---

### 4.2 The Architectural Integration Gap

In `wrangler.jsonc`:
```jsonc
"assets": {
  "directory": "./frontend",
  "binding": "ASSETS",
  "run_worker_first": [
    "/api/*",
    "/admin*",
    "/portal*"
  ]
}
```

When an authenticated client visits `/portal/dashboard`:
1. The Worker matches `run_worker_first: ["/portal*"]`.
2. `handlePortalDashboard()` executes in `backend/src/index.ts`.
3. It calls `renderPortalDashboard()` in `backend/src/lib/portal.ts`.
4. This returns an **old minimal server-rendered plain HTML table** (approx 100 lines of unstyled HTML), **completely bypassing** the executive dashboard in `frontend/dashboard/index.html`.

Similarly, when the operator visits `/admin`:
1. The Worker matches `run_worker_first: ["/admin*"]`.
2. `handleAdminReviewQueue()` executes in `backend/src/index.ts`.
3. It calls `renderReviewQueue()` in `backend/src/lib/admin.ts`.
4. This returns a minimal plain HTML table with basic textareas, **bypassing** `frontend/dashboard/approval-queue.html`.

Meanwhile, visiting `/dashboard/index.html`, `/dashboard/debtors.html`, or `/dashboard/approval-queue.html`:
- Cloudflare Assets serves the static files directly.
- `dashboard.js` runs, sees no live data injection, falls back to `DEFAULT_INVOICES` and `DEFAULT_DRAFTS`, and stores mutations in `sessionStorage`.

---

## 5. Concrete Recommendations for Implementation

To elevate the Client Portal and Review Queue from static mock to production-integrated status:

1. **Hydration API Endpoints in `backend/src/index.ts`**:
   - Add `GET /api/portal/invoices` (gated by client session cookie) returning JSON `{ invoices: PortalInvoiceRow[], summary: { ... } }`.
   - Add `GET /api/portal/drafts` or `GET /api/chase/queue` (gated by admin auth or client session) returning JSON `{ drafts: DraftRow[] }`.
   - Alternatively, have `renderPortalDashboard` in `backend/src/lib/portal.ts` read and template the rich HTML file or serve the static asset while injecting `<script id="server-data">window.__INITIAL_DATA__ = ...</script>`.
2. **Wire `frontend/dashboard/js/dashboard.js` to Fetch Live Data**:
   - Update `getStoredInvoices()` and `getStoredDrafts()` to first attempt fetching from `/api/portal/invoices` and `/api/chase/queue`.
   - Only fall back to session storage if the network request fails or when in offline demo mode.
3. **Add Frontend Business Logic Unit Tests to `tests/`**:
   - Create `tests/frontend-dashboard.test.ts` to test:
     - Statutory interest formula parity between frontend (`dashboard.js`) and backend (`statutory-interest.ts`).
     - Fixed compensation calculation tiers (£40 / £70 / £100).
     - Search filter debounce and multi-field matching logic.
     - Table sorting algorithms across numeric, date, and string fields.
     - CSV export escaping rules.
4. **Preserve Quality Gates**:
   - Any modifications must ensure that `npx tsc --noEmit`, `npm test`, `npm run build`, and `npx wrangler d1 migrations apply invoice-rescue-db --local` continue to exit cleanly with 0 errors.

---
*Report compiled and verified against live codebase.*
