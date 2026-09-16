## 2026-09-16T05:12:11Z

<USER_REQUEST>
You are the M1 OAuth Routes Explorer.
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_oauth_routes
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_survey_backend\report.md

Mission:
1. Investigate OAuth 2.0 connection lifecycle requirements for Milestone M1 (R1) for Xero and QuickBooks.
2. Design the zero-external-dependency OAuth endpoints in the Cloudflare Worker router:
   - `GET /api/oauth/:provider/connect`: generates secure state parameter, redirects to provider auth URL.
   - `GET /api/oauth/:provider/callback`: verifies state, exchanges auth code for tokens, encrypts access and refresh tokens using Web Crypto AES-GCM (256-bit) via `oauth-manager.ts`, and stores/updates in `accounting_connections` table.
   - Token refresh and disconnect endpoints.
3. Produce a detailed implementation plan for the worker with exact route patterns, parameter parsing, error responses, and mock/test modes.
4. Write your report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m1_oauth_routes\report.md and handoff.md.
5. Send a completion message to parent when done.

Rules:
- DO NOT modify or write source code files. Exploration and design recommendations only.
</USER_REQUEST>
