# Specification Mining Report: Review Queue & Statutory Display (Milestone M3 / Requirement R3)

**Document**: `report.md`  
**Milestone**: M3 (R3) — Client Portal & Human-in-the-Loop Review Queue  
**Author**: Review Queue & Statutory Display Spec Miner  
**Date**: 2026-09-16  
**Status**: COMPLETE / AUTHORITATIVE  

---

## 1. Executive Summary & Authoritative Sources

This specification defines the functional, UI, data layer, API, and accessibility contracts for the human-in-the-loop review queue and statutory claim calculation display for Invoice Rescue.

### Authoritative Specification Sources Probed:
1. `.agents/ORIGINAL_REQUEST.md`: Requirement R3, Escalation Acceptance Criteria, and UI/Accessibility acceptance gates.
2. `.agents/orchestrator/PROJECT.md`: Section 3 ("Statutory Calculation Engine"), Section 4 ("Client Portal & Draft Review API"), Features 10, 11, 12, 13, 16, 17, 18, 19.
3. `frontend/dashboard/approval-queue.html`: Semantic markup structure, header navigation, client metadata, queue status summary, ribbon layout, envelope metadata, and card components.
4. `frontend/dashboard/js/dashboard.js`: Client-side state handling, dynamic statutory calculations, DOM rendering, toast notifications, queue counting, in-place textarea editing, approve/skip REST dispatch, and activity logging.
5. `frontend/dashboard/css/dashboard.css`: Design system tokens, light/dark themes, responsive grid breakdowns, typography, focus indicators, badge colorways, and WCAG 2.2 Level AA accessibility rules.
6. `backend/src/lib/statutory-interest.ts`: Authoritative implementations of `fixedCompensationPence()` and `statutoryInterestPence()`.
7. `backend/src/lib/chase-runner.ts`: Cron generation logic, draft staging in `chase_log`, 7-day spacing enforcement, pending draft gating, and terminal state transitions.
8. `backend/src/lib/gemini.ts`: Prompt construction, locked sender model (`hello@invoicerescue.co.uk`), sign-off block enforcement (`Tibor Rames on behalf of [Client]`).
9. `backend/src/lib/tenant-repo.ts`: D1 tenant-isolated draft queries (`getTenantDrafts`, `approveTenantDraft`, `skipTenantDraft`).
10. `backend/src/index.ts`: Worker route handlers for `/admin`, `/api/chase/:id/approve`, `/api/chase/:id/skip`, `/api/statutory-rate`.
11. `tests/e2e/`: Passing automated test suites (Tiers 1–4, 376 tests) covering approval queue interactions, boundary conditions, and edge cases.

---

## 2. Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Financial Ribbon | Principal Debt Formatting | Displays the principal overdue balance in major currency units with tabular numerals | `draft.amount_pence`, `draft.currency` | Formatted string (e.g., `£4,850.00`, `USD 1,500.00`) | Defaults to GBP if currency omitted; values <= 0 rejected by D1 check constraint | `approval-queue.html:926`, `dashboard.js:315`, `PROJECT.md:65` |
| 2 | Financial Ribbon | Days Overdue Counter | Shows integer count of elapsed calendar days since the invoice due date | `invoice.due_date`, `currentDate` | Integer (e.g., `24 days overdue`) | Null `due_date` halts calculation; negative days treated as 0 | `chase-runner.ts:96`, `dashboard.js:329`, `escalation.ts:26` |
| 3 | Financial Ribbon | Statutory Fixed Compensation Tiers | Calculates mandatory statutory recovery fee under UK Late Payment Act 1998 / 2013 Regulations | `amount_pence` (Principal debt in pence) | `4000` (<£1k), `7000` (£1k–£9,999.99), `10000` (≥£10k) | Deterministic banded tiers; 0 pence yields £40 minimum | `statutory-interest.ts:13`, `tests/statutory-interest.test.ts:6` |
| 4 | Financial Ribbon | BoE + 8% Statutory Interest Accrual | Accrues daily simple statutory interest using the formula `(Principal * (BaseRate + 8) / 100 / 365) * Days` | `amountPence`, `daysOverdue`, `boeBaseRatePercent` | Accrued pence rounded to nearest integer via `Math.round` | Returns 0 if `daysOverdue <= 0`; single evaluation prevents compound drift | `statutory-interest.ts:19`, `tests/statutory-interest.test.ts:22` |
| 5 | Financial Ribbon | Dynamic Base Rate Retrieval | Exposes the current Bank of England base rate from Worker environment variable | `GET /api/statutory-rate` | JSON `{ boeBaseRatePercent: 3.75 }` (Cache-Control: 3600) | Falls back to client default 3.75% if API unreachable | `backend/src/index.ts:176`, `dashboard.js:476` |
| 6 | Financial Ribbon | Total Claim Calculation & Highlight | Aggregates Principal + Fixed Compensation + Statutory Interest into total debt owed | `amount_pence + comp_pence + interest_pence` | Highlighted total string in accent color (`.total-val`) | Non-mutating arithmetic; values always preserved in pence | `dashboard.js:904`, `dashboard.css:1359` |
| 7 | Envelope Display | Locked Verified Sender Model | Displays strictly enforced sender email with visual security badge | Sender address string `hello@invoicerescue.co.uk` | Display: `Invoice Rescue <hello@invoicerescue.co.uk>` + `🔒 Verified Sender` tag | Prompt generator and Worker forbid altering outbound sender address | `ORIGINAL_REQUEST.md:40`, `gemini.ts:65`, `dashboard.js:953` |
| 8 | Envelope Display | Debtor & Subject Envelope Meta | Renders recipient debtor contact info, email address, and stage-specific subject line | `debtor_name`, `debtor_email`, `subject`, `step` | Formatted header metadata block in `.envelope-meta` | Missing debtor email displays warning tag and prevents send | `approval-queue.html:84`, `dashboard.js:957`, `backend/src/index.ts:534` |
| 9 | Envelope Display | Operator Sign-Off Attribution Stamp | Displays verified sign-off badge identifying human operator Tibor Rames acting on behalf of client | `company_name`, operator name "Tibor Rames" | Visual stamp: `Operator Sign-Off: Drafted by AI, verified by Tibor Rames on behalf of [Company]` | Prompt template mandates verbatim sign-off block; rejects missing company | `gemini.ts:66`, `dashboard.js:982`, `chase-runner.ts:65` |
| 10 | Draft Editing | In-Place Textarea Mode Toggle | Switches draft card between read-only pre-wrap preview and editable multiline textarea | Click `#btn-edit-toggle-${id}` | Toggles display between `#view-mode-${id}` and `#edit-mode-${id}` | Focus automatically transfers to textarea; button text toggles | `dashboard.js:1015`, `dashboard.css:1431` |
| 11 | Draft Editing | Live Character Counter | Displays real-time character count of edited message text inside textarea | `textarea.input` event | Live string: `${count} characters` | Handles UTF-8 multi-byte characters and CRLF line breaks | `dashboard.js:977`, `dashboard.js:1036` |
| 12 | Draft Editing | Draft Save Action | Saves edited text to local memory/session and updates preview text | Click "Save Edit" button (`saveDraftEdit(id)`) | Updates `draft.body`, updates `#body-text-${id}`, closes edit mode | Empty trimmed string rejected; preserves prior text | `dashboard.js:1042`, `tests/e2e/tier2-boundaries.test.ts:1111` |
| 13 | Draft Editing | Backend Text Update (PUT API) | REST endpoint to update draft body directly in D1 `chase_log` without approving | `PUT /api/admin/drafts/:id` or form body param | Updates `chase_log.body` where `id = ? AND status = 'draft'` | Returns 404 if draft not found or already sent/skipped | `PROJECT.md:84`, `backend/src/index.ts:548` |
| 14 | Queue Action | Approve & Send Outbound Dispatch | Dispatches approved draft to debtor, updates D1 database, and records audit trail | `POST /api/chase/:id/approve` or `POST /api/admin/drafts/:id/approve` | Email sent via `env.SEND.send()`, `status='sent'`, `outcome='sent'` | Returns 404 if not draft; returns 422 if invoice has no debtor email | `backend/src/index.ts:518`, `tests/e2e/tier1-features.test.ts:1449` |
| 15 | Queue Action | Skip & Defer Chase Action | Defers or skips staged draft without dispatching email | `POST /api/chase/:id/skip` or `POST /api/admin/drafts/:id/skip` | `chase_log.status='skipped'`, `reviewed_at=datetime('now')` | No outbound email sent via SEND or NOTIFY; idempotent operation | `backend/src/index.ts:566`, `tests/e2e/tier2-boundaries.test.ts:1233` |
| 16 | Queue Action | Operator Audit Attribution | Records reviewing operator identity and timestamp on approval | `env.OPERATOR_NAME` ("Tibor Rames"), `datetime('now')` | `chase_log.reviewed_by = ?`, `chase_log.reviewed_at = ?` | Recorded in D1 audit trail and surfaced on client portal | `backend/src/index.ts:558`, `portal.ts:80`, `PROJECT.md:82` |
| 17 | Queue UI | Interactive Loading State | Visual loading spinner and disabled state during network dispatch | Click `#btn-approve-${id}` | Button disables, shows `⏳ Sending...` spinner | Re-enables on network error; prevents double-clicks | `dashboard.js:1063` |
| 18 | Queue UI | Toast Notification Dispatch | Accessible non-blocking feedback notifications for queue operations | Toast message string, status type (`success` / `danger`) | Appends `.toast` element to `#toast-container` (`role="status"`) | Automatically fades out and unmounts after 4,000ms | `dashboard.js:390`, `dashboard.css:1502` |
| 19 | Queue UI | Queue Count & Header Badge Sync | Real-time synchronization of pending draft counters across UI elements | State array `drafts.length` | Updates `#queue-count-display` and `.nav-badge-drafts` | When count is 0, badge hides (`display: none;`) | `approval-queue.html:39`, `dashboard.js:457`, `dashboard.js:879` |
| 20 | Queue UI | Dynamic Empty State Display | Celebratory empty state rendered when all queued drafts have been reviewed | `drafts.length === 0` | Renders panel with `🎉`, caught-up title, next-schedule info, and ledger link | Replaces list cleanly without leaving orphaned DOM nodes | `approval-queue.html:91`, `dashboard.js:884`, `dashboard.css:1215` |
| 21 | Queue UI | Cross-Page Alert Banners | Warning banner on executive overview indicating unreviewed drafts | `drafts.length > 0` | Displays `.alert-banner-pending` with counter on overview page | Automatically hidden when queue is cleared | `dashboard.js:467`, `index.html` |
| 22 | Activity Log | Queue Action Feed Ingestion | Automatically registers recent activity feed items on draft approval | Action metadata (`type="sent"`, invoice details, amount, time) | Prepends item to `ir_dashboard_activities` and updates feed | Persists across navigation in `sessionStorage` | `dashboard.js:1095`, `dashboard.js:587` |
| 23 | Ledger Sync | Invoice Status Update Reflection | Updates debtor invoice `last_contact` label when draft approved | Invoice ID matching draft | Updates `last_contact = "Just now (Sent)"` in invoice state | Keeps debtor ledger and dashboard metrics in immediate sync | `dashboard.js:1104` |
| 24 | Theming & A11y | Dark/Light Mode Theme Toggle | Full dual-theme styling with high-contrast color tokens | Click `#theme-toggle-btn` or OS `prefers-color-scheme` | Sets `data-theme="dark"` or `"light"` on `<html>`, saves in `localStorage` | Preserves state across navigations; smooth 0.2s color transitions | `dashboard.js:428`, `dashboard.css:71` |
| 25 | Theming & A11y | WCAG 2.2 AA Keyboard Navigation | Focus visible outlines, skip links, semantic regions, and ARIA labels | Tab / Enter / Space key interaction | 2px high-contrast outline on `:focus-visible`, skip to `#main` | No keyboard traps; all buttons and inputs reachable | `approval-queue.html:14`, `dashboard.css:214` |

---

## 3. Edge Cases Discovered & Observed Behaviors

| # | Feature | Input / Boundary Condition | Observed Behavior |
|---|---------|----------------------------|-------------------|
| 1 | Statutory Compensation | Invoice amount exactly £999.99 (99,999 pence) | Returns Tier 1 compensation: £40.00 (4,000 pence). Strictly `< 100_000`. |
| 2 | Statutory Compensation | Invoice amount exactly £1,000.00 (100,000 pence) | Returns Tier 2 compensation: £70.00 (7,000 pence). Boundary `>= 100_000` cleanly jumps to tier 2. |
| 3 | Statutory Compensation | Invoice amount exactly £9,999.99 (999,999 pence) | Returns Tier 2 compensation: £70.00 (7,000 pence). Strictly `< 1_000_000`. |
| 4 | Statutory Compensation | Invoice amount exactly £10,000.00 (1,000,000 pence) | Returns Tier 3 compensation: £100.00 (10,000 pence). Boundary `>= 1_000_000` cleanly jumps to tier 3. |
| 5 | Statutory Compensation | Principal amount £0.00 (0 pence) | Returns Tier 1 (£40.00). In practice, database rejects non-positive amounts (`CHECK (amount_pence > 0)`). |
| 6 | Statutory Interest | Zero days overdue (`daysOverdue = 0`) | Returns exactly 0 pence interest. Accrual formula multiplies by 0. |
| 7 | Statutory Interest | 1 full year overdue (365 days) at 3.75% BoE rate (£1,000 principal) | Returns exactly 11,750 pence (11.75% annual rate of 100,000 pence = £117.50). Zero rounding drift. |
| 8 | Statutory Interest | Fractional pence rounding: £5,000 for 30 days at 3.75% rate | Exact computation: 4828.7671... pence; `Math.round()` yields 4,829 pence (£48.29). |
| 9 | Statutory Interest | Multi-year overdue across leap years (e.g. 2024 / 2028) | Single-evaluation formula `(Principal * Rate / 365) * days` executes deterministically without accumulating daily rounding error. |
| 10 | Draft Generation | Stage 1 (Gentle) draft prompt creation | Statutory interest and fixed compensation instructions are strictly omitted from prompt (`Do not mention statutory interest yet`). |
| 11 | Draft Generation | Stage 3 (Firm) draft prompt creation | Statutory interest and fixed compensation are explicitly injected into prompt and cited under the Late Payment Act 1998. |
| 12 | Draft Generation | Stage 4 (Final) draft prompt creation | Injects statutory claims and explicitly mandates formal 7-day notice before client hand-back. |
| 13 | Pending Draft Gating | Cron runs while an unreviewed draft already exists for invoice | Invoice is skipped; `draftsCreated` = 0, `skippedDrafts` = 1. Prevents duplicate drafts piling up in review queue. |
| 14 | 7-Day Spacing | Invoice imported 20 days overdue; Stage 1 sent on Day 20 | On Day 21 (21 days overdue), cron evaluates `daysSinceChase = 1 < 7` and suppresses Stage 2 generation until Day 27. |
| 15 | Terminal Escalation | Stage 4 sent and 7+ days elapse without payment | Invoice status transitions to `escalated`; operator alerted via `env.NOTIFY`; no further drafts created. |
| 16 | Gemini Outage | Gemini API returns 503 Service Unavailable | Fallback draft generator (`generateFallbackDraft`) synthesizes deterministic statutory draft with locked sign-off into `chase_log`. |
| 17 | In-Place Editing | Operator enters empty or whitespace-only text | Save edit rejects empty text or unedited approval preserves previous draft body without wiping message. |
| 18 | In-Place Editing | Operator enters large body (2,000+ characters) | Textarea preserves entire message; D1 `chase_log.body` TEXT column stores full text without truncation. |
| 19 | In-Place Editing | Operator enters Windows CRLF newlines (`\r\n`) | Newlines preserved cleanly in database, textarea, and outbound email body. |
| 20 | In-Place Editing | Operator inputs HTML special characters (`<`, `>`, `&`, `"`, `'`) | Content properly escaped in view mode and textarea markup (`escapeHtml`) to eliminate XSS risks. |
| 21 | In-Place Editing | Operator includes Unicode / Emoji (`💰`, `🤝`, `£`) | Full UTF-8 multi-byte encoding maintained across D1, textarea, and MIME email body. |
| 22 | Queue Approval | Approving draft for invoice with NULL `debtor_email` | Endpoint halts before sending; returns HTTP 422 Unprocessable Entity (`Invoice has no debtor email on file.`). |
| 23 | Queue Approval | Approving non-existent draft ID (e.g. `999999`) | Returns HTTP 404 Not Found (`Draft not found or already reviewed.`). |
| 24 | Queue Approval | Approving draft that was already approved (`status != 'draft'`) | Returns HTTP 404 Not Found; prevents duplicate sends via `env.SEND`. |
| 25 | Queue Approval | Unauthenticated request to `/api/chase/:id/approve` | Returns HTTP 401 Unauthorized (`requireAdminAuth` gates with Basic Auth realm). |
| 26 | Queue Skip | Skipping draft that was already skipped | Idempotent operation: executes `UPDATE ... WHERE id = ? AND status = 'draft'` and returns HTTP 200 without error. |
| 27 | Queue Skip | Email delivery check on skip | Zero emails dispatched via `env.SEND` or `env.NOTIFY`. |
| 28 | Concurrent Actions | Webhook marks invoice `paid` while draft is open in queue | Reconcile sets invoice `status='paid'`, sets pending draft `status='skipped'`. Approval attempt fails with 404. |
| 29 | Empty Queue | Queue reaches 0 pending drafts | Dynamic view unmounts list and displays celebratory panel (`🎉`) with link to Debtor Ledger; hides nav badge. |
| 30 | High Contrast / Dark | User switches between Light Paper and Dark Slate | Contrast ratio exceeds WCAG 2.2 AA (14.2:1 light, 16.8:1 dark). Ribbon total text switches between `--accent-dark` and `--accent`. |

---

## 4. Component Deep-Dives & Interface Specifications

### 4.1 Financial Ribbon Breakdown Specification

The statutory claim ribbon is positioned directly beneath the draft card header and above the envelope preview. It provides instant transparency into statutory debt inflation.

#### Visual Layout Contract (CSS Grid):
```html
<div class="claim-breakdown-ribbon" role="region" aria-label="Statutory claim financial breakdown">
  <div class="claim-item">
    <span class="claim-label">Principal Invoice</span>
    <span class="claim-val">£4,850.00</span>
  </div>
  <div class="claim-item">
    <span class="claim-label">Days Overdue</span>
    <span class="claim-val">24 days</span>
  </div>
  <div class="claim-item">
    <span class="claim-label">Fixed Compensation</span>
    <span class="claim-val">£70.00</span>
  </div>
  <div class="claim-item">
    <span class="claim-label">Statutory Interest</span>
    <span class="claim-val">£37.47</span>
  </div>
  <div class="claim-item">
    <span class="claim-label">Total Claim Owed</span>
    <span class="claim-val total-val">£4,957.47</span>
  </div>
</div>
```

#### Calculations & Constants:
- **Base Rate Formula**:
  $$\text{Daily Interest} = \left( \frac{\text{Principal (pence)} \times (\text{BoE Base Rate} + 8)}{100 \times 365} \right) \times \text{Days Overdue}$$
  $$\text{Interest (pence)} = \text{round}(\text{Daily Interest})$$
- **Statutory Margin**: Strictly 8.00% under Late Payment of Commercial Debts (Interest) Act 1998.
- **Fixed Compensation Bands (2013 Regulations)**:
  - Principal $< \text{£1,000}$ ($100,000\text{p}$): $\text{£40.00}$ ($4,000\text{p}$)
  - $\text{£1,000} \le \text{Principal} < \text{£10,000}$ ($100,000\text{p}$ to $999,999\text{p}$): $\text{£70.00}$ ($7,000\text{p}$)
  - Principal $\ge \text{£10,000}$ ($1,000,000\text{p}$): $\text{£100.00}$ ($10,000\text{p}$)
- **Total Claim**:
  $$\text{Total Claim (pence)} = \text{Principal} + \text{Fixed Compensation} + \text{Statutory Interest}$$

---

### 4.2 Locked Sender & Verified Sign-Off Specification

The human review queue guarantees that every debtor email is attributed to Invoice Rescue's authenticated domain and signed by operator Tibor Rames on behalf of the client organization.

#### 1. Envelope Display Contract:
- **From Field**: `Invoice Rescue <hello@invoicerescue.co.uk>`
- **Verified Badge**: `🔒 Verified Sender` (Tooltip: "Sender address is locked to our verified email sending domain").
- **Header Summary Card**:
  - Sender domain: `cf-bounce.invoicerescue.co.uk`
  - Authentication: "DMARC & SPF aligned · Strict 15-minute token auth"
- **To Field**: `${draft.debtor_name} <${draft.debtor_email}>`
- **Subject Field**: `${draft.subject}` (Bold, high contrast)

#### 2. Sign-off Stamp Block:
```html
<div class="human-signoff-stamp">
  <span class="stamp-badge">Operator Sign-Off</span>
  <span>Drafted by AI, verified by <strong>Tibor Rames</strong> on behalf of Apex Studio Ltd.</span>
</div>
```

#### 3. Mandatory Email Body Sign-Off:
Every message body (whether drafted by Gemini, edited by human, or generated via fallback) must end with this exact block:
```text
Tibor Rames
Invoice Rescue — acting on behalf of [Client Company Name]
hello@invoicerescue.co.uk
```

---

### 4.3 In-Place Draft Editing Specification

The review queue allows operators to modify any AI-generated draft before approval without page reloads.

#### State Transitions:
1. **Initial View State**:
   - Element `#view-mode-${id}` is visible (`display: block`).
   - Element `#edit-mode-${id}` is hidden (`display: none`).
   - Button `#btn-edit-toggle-${id}` displays "Edit Message".
2. **Editing State**:
   - Operator clicks "Edit Message".
   - `#view-mode-${id}` hides; `#edit-mode-${id}` displays.
   - Button `#btn-edit-toggle-${id}` displays "Cancel Edit".
   - Textarea `#textarea-msg-${id}` receives input focus.
   - Character counter `#char-count-${id}` listens for `input` events and displays `${textarea.value.length} characters`.
3. **Save Action**:
   - Operator clicks "Save Edit" button.
   - Validates input: `const newContent = textarea.value.trim()`.
   - If valid, updates draft in memory and `sessionStorage`.
   - Updates `#body-text-${id}` text content.
   - Closes edit mode (restores view mode).
   - Displays toast: `"Draft message updated successfully"` (success type).

---

### 4.4 "Approve & Send" and "Skip/Defer" Actions

#### 1. Approve & Send Flow:
1. Operator clicks `#btn-approve-${id}`.
2. UI sets `btn.disabled = true` and shows `<span class="spinner">⏳</span> Sending...`.
3. Dispatches HTTP POST to `/api/chase/${id}/approve` (or `/api/admin/drafts/${id}/approve`).
   - Request headers: `Authorization: Basic ...`, `Accept: application/json`, `Content-Type: application/x-www-form-urlencoded`.
   - Request body: `body=${encodeURIComponent(draft.body)}`.
4. Worker verifies:
   - Basic Auth / session valid.
   - Draft exists in `chase_log` with `status = 'draft'`.
   - Invoices row has non-null `debtor_email`.
5. Worker executes:
   - `await env.SEND.send({ to: debtor_email, from: { name: "Invoice Rescue", email: env.NOTIFY_FROM }, subject, text: body })`.
   - `UPDATE chase_log SET status = 'sent', body = ?2, outcome = 'sent', reviewed_at = datetime('now'), reviewed_by = ?3 WHERE id = ?1`.
6. Client removes card from DOM, updates badge counts, adds item to activity log, updates invoice `last_contact`, and displays success toast.

#### 2. Skip/Defer Flow:
1. Operator clicks "Skip / Defer" button.
2. Dispatches HTTP POST to `/api/chase/${id}/skip`.
3. Worker executes:
   - `UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE id = ?1 AND status = 'draft'`.
   - Zero emails sent.
4. Client removes card from DOM, updates counters, shows warning toast: `Draft for ${draft.invoice_number} skipped`.

---

### 4.5 Empty States & Alert Banners

#### 1. Zero Drafts State:
When all drafts have been approved or deferred (`drafts.length === 0`), `#approval-queue-list` renders:
```html
<div class="panel">
  <div class="empty-state">
    <div class="empty-state-icon" aria-hidden="true">🎉</div>
    <h3 class="empty-state-title">All caught up! No drafts awaiting review</h3>
    <p>Every staged escalation has been reviewed and dispatched. The daily scheduler checks for overdue transitions at 06:00 UTC.</p>
    <div style="margin-top: 20px;">
      <a href="debtors.html" class="btn btn-secondary">View Debtor Ledger</a>
    </div>
  </div>
</div>
```

#### 2. Queue Summary & Navigation Badge:
- Header badge (`.nav-badge-drafts`):
  - Displays count when $> 0$.
  - Hidden (`display: none`) when $= 0$.
- Page summary counter (`#queue-count-display`):
  - Synchronized with active draft array length.

---

### 4.6 REST Endpoints Contract Summary

| Method | Path | Purpose | Request Body | Response (200 OK) | Error Codes |
|---|---|---|---|---|---|
| `GET` | `/admin` | Render server-side review queue page | None | HTML page with drafts table | 401 Unauthorized |
| `GET` | `/api/admin/drafts` | Fetch structured draft list with calculations | None | `{ drafts: DraftItem[] }` | 401 Unauthorized |
| `POST` | `/api/chase/:id/approve` | Approve draft, send email, log audit | `body` (form-data or JSON) | `{ ok: true }` | 401, 404, 422 |
| `POST` | `/api/chase/:id/skip` | Defer / skip staged draft | None | `{ ok: true }` | 401, 404 |
| `PUT` | `/api/admin/drafts/:id` | Update draft body without approving | `{ body: string }` | `{ ok: true, id, body }` | 401, 404, 400 |
| `GET` | `/api/statutory-rate` | Fetch BoE base rate for calculations | None | `{ boeBaseRatePercent: number }` | 500 (falls back) |

---

## 5. Verification Matrix

| Verification Target | Test Command / Inspection Method | Expected Result |
|---|---|---|
| Statutory Calculation Accuracy | `npm test` (specifically `tests/statutory-interest.test.ts`) | 100% passing; exact fixed bands (£40/£70/£100) and BoE+8% daily accrual |
| Draft Approval & Split-Trust Sending | `tests/e2e/tier1-features.test.ts` (T1.F18.1–5) | Draft status transitions to `'sent'`, `env.SEND.send()` called with `hello@invoicerescue.co.uk` |
| Draft Skipping Without Delivery | `tests/e2e/tier2-boundaries.test.ts` (T2.F18.5) | Draft transitions to `'skipped'`, 0 emails sent via SEND or NOTIFY |
| In-Place Draft Editing | `tests/e2e/tier1-features.test.ts` (T1.F17.2) | Submitting edited body updates `chase_log.body` and delivers edited text |
| Full Application Scenario Pass | `tests/e2e/tier4-scenarios.test.ts` (Scenario 1) | Complete end-to-end flow passes: Import -> Cron -> Review -> Approve -> Paid |
| Full Test Suite Suite Pass | `npm test` | All 376 tests across 75 suites pass cleanly |
