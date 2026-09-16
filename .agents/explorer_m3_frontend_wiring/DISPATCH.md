## 2026-09-16T08:03:03Z
You are the Frontend Dashboard Wiring Explorer for Milestone M3 (Client Portal & Review Queue - R3).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_frontend_wiring
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- frontend/dashboard/index.html
- frontend/dashboard/debtors.html
- frontend/dashboard/approval-queue.html
- frontend/dashboard/js/dashboard.js
- frontend/dashboard/css/dashboard.css

Mission:
1. Examine `frontend/dashboard/js/dashboard.js` and determine how to connect the frontend to live backend APIs while maintaining resilient offline/demo capability:
   - Connect dashboard metrics and aging gauge to `GET /api/portal/dashboard-data`.
   - Connect debtor ledger search, stage/status filtering, and multi-column sorting to `GET /api/portal/debtors`.
   - Connect approval queue to `GET /api/admin/drafts`, `POST /api/admin/drafts/:id/approve`, `POST /api/admin/drafts/:id/skip`, and `PUT /api/admin/drafts/:id`.
   - Ensure fallback to seeded mock data if the API returns non-200 or network is unavailable (graceful degradation).
2. Validate compliance with WCAG 2.2 Level AA accessibility:
   - Skip links (`<a href="#main" class="skip-link">`).
   - Focus indicators and keyboard navigability.
   - Screen reader labels (`aria-live="polite"`, `role="progressbar"`, `aria-sort`).
   - Color contrast (>15:1).
3. Validate responsive layouts (desktop, tablet, mobile) and dark/light theme switching with localStorage persistence (`invoice_rescue_theme`).
4. Produce exact recommendations and code changes for the worker.
5. Write your findings to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_frontend_wiring\report.md and handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m3_frontend_wiring\handoff.md.
6. Send completion message to parent when done.

Rules:
- DO NOT modify source code files. Exploration only.
- Write metadata only to your assigned directory.
