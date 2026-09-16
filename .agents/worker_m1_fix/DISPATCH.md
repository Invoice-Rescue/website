## 2026-09-16T07:30:58Z
You are the M1 Remediation Worker.
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m1_fix
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m1_1\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\challenger_m1_1\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m1_1\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m1_2\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Exclusive Write Ownership:
- backend/src/index.ts
- backend/src/lib/integrations/sync-service.ts
- tests/oauth-endpoints.test.ts
- tests/adversarial-m1.test.ts

Mission & Tasks:
1. Review Challenger 1's empirical finding in .agents/challenger_m1_1/report.md:
   In backend/src/index.ts lines 1092, 1153, and 1196, `handleOAuthDisconnect`, `handleOAuthRefresh`, and `handleOAuthStatus` fall back to adopting `body.client_id` or query `client_id` when the request is unauthenticated (`clientId === null`). This allows unauthorized third parties to delete or inspect other tenants' connections.
2. Fix the vulnerability in backend/src/index.ts:
   - Remove the unauthenticated fallback on `client_id` in `handleOAuthDisconnect`, `handleOAuthRefresh`, and `handleOAuthStatus`.
   - Enforce strict authentication: If `clientId === null`, return `new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: jsonHeaders })` immediately.
   - For administrative access, support `requireAdminAuth(request, env)` if an operator needs to manage a client's connection, but NEVER allow unauthenticated anonymous callers to pass a client_id.
   - In backend/src/lib/integrations/sync-service.ts, remove any insecure hardcoded fallback secret in `getEncryptionSecret()`; throw a clear configuration error if `TOKEN_ENCRYPTION_SECRET` is missing. Log a warning with `console.warn` if external token revocation encounters a network error instead of silent swallowing.
3. Update tests:
   - Update `tests/oauth-endpoints.test.ts` to assert that unauthenticated requests to `/api/oauth/:provider/disconnect`, `/refresh`, and `/status` return HTTP 401.
   - Update `tests/adversarial-m1.test.ts` (especially lines 434-456) so the boundary test asserts that unauthenticated requests are strictly rejected with 401 and DO NOT delete the connection.
4. Run all verification quality gates:
   - `npx tsc --noEmit` -> 0 errors.
   - `npm test` -> 100% passing.
   - `npm run build` -> clean dry run.
   - `npx wrangler d1 migrations apply invoice-rescue-db --local` -> clean.
5. Produce a detailed handoff report in d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m1_fix\handoff.md documenting your changes, test results, and verification outputs.
6. Send completion message to parent when done.
