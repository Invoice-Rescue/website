## 2026-09-16T13:09:14Z

You are the Milestone M4 Implementation Worker (Edge Infrastructure & Deliverability Controls - R4).
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m4
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read before writing code:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_edge_deps\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_edge_deps\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_email_routing\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_email_routing\handoff.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_d1_migrations\report.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_d1_migrations\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Exclusive Write Ownership:
- backend/src/lib/email.ts
- backend/src/lib/chase-runner.ts
- backend/src/lib/portal-api.ts
- backend/src/index.ts
- backend/db/migrations/0007_query_indices.sql
- tests/email-deliverability.test.ts

Mission & Implementation Requirements:
1. Create `backend/src/lib/email.ts` implementing Interface Contract 5:
   - `sendOperatorNotification(env: Env, subject: string, body: string): Promise<boolean>`
     - Uses `env.NOTIFY`
     - Recipient locked to operator address: `tiborcc2@gmail.com`
     - Sender locked to: `Invoice Rescue <hello@invoicerescue.co.uk>`
     - Deliverability headers: `Auto-Submitted: auto-generated`, `Message-ID: <${crypto.randomUUID()}@invoicerescue.co.uk>`, `Date: ${new Date().toUTCString()}`
     - Resilient error handling: wraps `env.NOTIFY.send` in try/catch, logs error with `console.error`, and returns `false` instead of throwing uncaught exceptions.
   - `sendDebtorCommunication(env: Env, to: string, subject: string, body: string, options?: { clientBusinessName?: string }): Promise<boolean>`
     - Uses `env.SEND`
     - Sender locked to: `Invoice Rescue <hello@invoicerescue.co.uk>`
     - Sign-off by Tibor Rames on behalf of client
     - Deliverability headers: `Auto-Submitted: auto-generated`, `Message-ID: <${crypto.randomUUID()}@invoicerescue.co.uk>`, `Date: ${new Date().toUTCString()}`, `Reply-To: hello@invoicerescue.co.uk`
     - Returns boolean indicating success.
2. Refactor `backend/src/lib/chase-runner.ts`:
   - Import and use `sendOperatorNotification` from `backend/src/lib/email.ts` for Stage 4 terminal hand-back alerts and cron summary alerts.
   - Guarantees the daily overdue detection cron runner will never crash on transient email send failures.
3. Refactor `backend/src/lib/portal-api.ts`:
   - Import and use `sendDebtorCommunication` from `backend/src/lib/email.ts` in `handleApproveDraft`.
4. Clean up route shadowing in `backend/src/index.ts`:
   - Remove legacy shadow handler `handleChaseApprove` in `index.ts` so route dispatch cleanly delegates `/api/admin/drafts/:id/approve` and `/api/chase/:id/approve` to `portal-api.ts`.
5. Create migration `backend/db/migrations/0007_query_indices.sql`:
   - Add high-frequency performance indices identified by explorer:
     `CREATE INDEX IF NOT EXISTS idx_chase_log_status ON chase_log(status);`
     `CREATE INDEX IF NOT EXISTS idx_accounting_connections_lookup ON accounting_connections(provider, tenant_id);`
     `CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);`
     `CREATE INDEX IF NOT EXISTS idx_invoices_client_due ON invoices(client_id, due_date DESC);`
6. Author automated test suite in `tests/email-deliverability.test.ts`:
   - Test `sendOperatorNotification` sends via `env.NOTIFY` to `tiborcc2@gmail.com` with required deliverability headers.
   - Test `sendDebtorCommunication` sends via `env.SEND` to debtor with locked sender and required deliverability headers.
   - Test transient email send failure does not throw in `sendOperatorNotification`.
   - Test that migration `0007_query_indices.sql` applies cleanly and speeds up indexed queries.
7. Verification & Quality Gates:
   - Run `npx tsc --noEmit` -> 0 errors.
   - Run `npm test` -> 100% passing across all test suites.
   - Run `npm run build` -> clean dry-run bundle.
   - Run `npx wrangler d1 migrations apply invoice-rescue-db --local` -> applies migration 0007 cleanly.
8. Handoff:
   - Write comprehensive handoff report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\worker_m4\handoff.md documenting all changes, verification commands, and full test outputs.
   - Send completion message to parent when done.
