# Handoff: Email Deliverability & Split-Trust Routing (Milestone M4)

**Role**: Email Deliverability & Split-Trust Routing Explorer (Milestone M4 / R4)  
**Target File**: `d:\Dev\Workspaces\Active\invoice-rescue\.agents\explorer_m4_email_routing\handoff.md`  
**Date**: 2026-09-16  

---

## 1. Observation

1. **Missing Module & Contract Violation**:
   - `PROJECT.md` line 100 specifies `- backend/src/lib/email.ts: Split-trust email delivery routines (NOTIFY vs SEND)` and Interface Contract 5 specifies `sendOperatorNotification(env: Env, subject: string, body: string)` and `sendDebtorCommunication(env: Env, to: string, subject: string, body: string)`.
   - Inspection of `backend/src/lib/` confirms `email.ts` does **not** exist in the filesystem (`open d:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/email.ts: The system cannot find the file specified`).
2. **Binding Configurations in `wrangler.jsonc`**:
   - Lines 37–50 of `wrangler.jsonc`:
     ```jsonc
     "send_email": [
       {
         "name": "NOTIFY",
         "destination_address": "tiborcc2@gmail.com"
       },
       {
         "name": "SEND"
       }
     ]
     ```
     `NOTIFY` is locked by Cloudflare Workers runtime to `tiborcc2@gmail.com`; `SEND` is unrestricted.
3. **Direct Call Sites Across the Codebase**:
   - `backend/src/index.ts:345` (`handleLead`): `await env.NOTIFY.send({ to: env.NOTIFY_TO, from: { name: SENDER_NAME, email: env.NOTIFY_FROM }, ... })` inside a `try/catch`.
   - `backend/src/index.ts:803` (`handleStripeWebhook`): `await env.NOTIFY.send({ to: env.NOTIFY_TO, ... })` inside a `try/catch`.
   - `backend/src/lib/chase-runner.ts:157` (`runOverdueDetection` terminal escalation): `await env.NOTIFY.send({ to: env.NOTIFY_TO, ... })` with **no `try/catch`**.
   - `backend/src/lib/chase-runner.ts:245` (`runOverdueDetection` review queue digest): `await env.NOTIFY.send({ to: env.NOTIFY_TO, ... })` with **no `try/catch`**.
   - `backend/src/lib/portal-api.ts:755` (`handleApproveDraft`): `await env.SEND.send({ to: row.debtor_email, from: { name: SENDER_NAME, email: env.NOTIFY_FROM || LOCKED_SENDER_EMAIL }, ... })` with **no local `try/catch`**.
   - `backend/src/index.ts:575` (`handleChaseApprove`): Legacy uncalled method calling `env.SEND.send` directly.
   - `backend/src/index.ts:646` (`handlePortalLoginRequest`): `await env.SEND.send({ to: email, ... })` inside a `try/catch`.
   - `backend/src/index.ts:866` (`runFridayReport`): `await env.SEND.send({ to: client.contact_email, ... })` inside a per-client `try/catch`.
4. **Header and Deliverability Inspection**:
   - Across all 8 call sites, only `{ to, from, subject, text }` are supplied.
   - Headers specified in RFC standards are missing:
     - `Auto-Submitted: auto-generated` (RFC 3834) is missing on automated operator alerts and digests.
     - `Message-ID` (RFC 5322) and `Date` (RFC 2822) are not explicitly set.
     - `replyTo: "hello@invoicerescue.co.uk"` is not explicitly set in `handleApproveDraft`.
5. **Test Harness Mock Implementation (`tests/e2e/harness.ts:13–23`)**:
   - `MockEmailBinding` accepts any destination on `env.NOTIFY` without asserting `message.to === env.NOTIFY_TO`.
6. **Command Results**:
   - `npm test`: Exits with code 0 (464 tests passing, 96 suites).
   - `npm run typecheck; npm run build`: Exits with code 0 (`tsc --noEmit` clean, `wrangler deploy --dry-run` confirms `env.NOTIFY` and `env.SEND` bindings).

---

## 2. Logic Chain

1. **Contract Gap**: Interface Contract 5 in `PROJECT.md` establishes that all email interactions must go through `backend/src/lib/email.ts`. Because callers interact directly with `env.NOTIFY` and `env.SEND`, there is no single enforcement point for split-trust routing, header injection, or error normalization (Observation 1).
2. **Split-Trust Soundness**: In all actual call sites, operator alerts are dispatched exclusively via `env.NOTIFY` to `env.NOTIFY_TO`, and debtor/client messages are dispatched exclusively via `env.SEND`. Furthermore, `wrangler.jsonc` enforces this at the Cloudflare edge level for `NOTIFY` via `destination_address: "tiborcc2@gmail.com"`. There is currently no active cross-contamination between `NOTIFY` and `SEND` (Observation 2, 3).
3. **Cron Reliability Hazard**: Because `chase-runner.ts` lines 157 and 245 invoke `env.NOTIFY.send()` without error handling, any failure in Cloudflare's email dispatch (e.g. rate limit, temporary network blip) will throw an unhandled exception that aborts `runOverdueDetection()` mid-execution, leaving remaining overdue invoices un-escalated (Observation 3).
4. **Deliverability & Spam Risk**: Automated system notifications lacking `Auto-Submitted: auto-generated` can trigger recursive mail loops if the operator or client uses an out-of-office autoreply. Absence of explicit `Message-ID`, `Date`, and `Reply-To` headers lowers mail reputation scores in strict corporate filtering environments (Observation 4).
5. **Mock Test Blind Spot**: Because `MockEmailBinding` does not emulate Cloudflare's destination constraint, tests cannot detect if a developer mistakenly points debtor mail to `env.NOTIFY` (Observation 5).

---

## 3. Caveats

- Outbound deliverability in live production relies on Cloudflare's shared or dedicated IP pool and DNS configuration (`cf-bounce.invoicerescue.co.uk`). In local testing and dry-run bundling, actual SMTP transmission cannot be tested live without a configured domain on Cloudflare Email Routing.
- The `destination_address` constraint in `wrangler.jsonc` is enforced by Cloudflare's edge runtime in deployed workers; Miniflare/Node local unit tests do not natively simulate this unless explicitly programmed in `MockEmailBinding`.
- No caveats regarding backend source code access or database schema constraints.

---

## 4. Conclusion

1. **Architecture Status**: Split-trust separation between `NOTIFY` and `SEND` is conceptually sound and enforced at the edge by `wrangler.jsonc`, but lacks the required software abstraction layer (`backend/src/lib/email.ts`).
2. **Actionable Implementation Requirements for M4**:
   - Create `backend/src/lib/email.ts` with `sendOperatorNotification()` and `sendDebtorCommunication()`.
   - Inject required deliverability headers: `Auto-Submitted: auto-generated` (for automated alerts), `Message-ID`, `Date`, `X-Mailer`, and explicit `Reply-To`.
   - Wrap `env.NOTIFY.send()` in `chase-runner.ts` so email dispatch failures do not crash the daily overdue cron job.
   - Clean up dead code `handleChaseApprove` in `backend/src/index.ts`.
   - Update `MockEmailBinding` in `tests/e2e/harness.ts` to enforce destination address restrictions on `env.NOTIFY`.
   - Provide comprehensive unit tests in `tests/email.test.ts`.

---

## 5. Verification Method

To verify these findings independently:

1. **Verify Absence of `email.ts`**:
   ```powershell
   Test-Path backend/src/lib/email.ts
   # Returns False
   ```
2. **Verify Bindings in `wrangler.jsonc`**:
   Inspect lines 37–50 of `wrangler.jsonc` to confirm `destination_address` on `NOTIFY` and unrestricted `SEND`.
3. **Verify Unhandled `env.NOTIFY` Calls in `chase-runner.ts`**:
   Inspect `backend/src/lib/chase-runner.ts` lines 157–163 and lines 245–251 to confirm the absence of `try/catch` blocks around `await env.NOTIFY.send(...)`.
4. **Verify Typecheck and Tests**:
   ```powershell
   npx tsc --noEmit
   npm test
   wrangler deploy --dry-run
   ```
