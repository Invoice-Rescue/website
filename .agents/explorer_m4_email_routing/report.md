# Email Deliverability & Split-Trust Routing Analysis (Milestone M4)

**Role**: Email Deliverability & Split-Trust Routing Explorer (Milestone M4 / R4)  
**Date**: 2026-09-16  
**Repository**: `invoice-rescue` (Cloudflare Worker + D1 SQLite)  
**Status**: Exploration Complete — Ready for M4 Implementation  

---

## Executive Summary

This investigation evaluates the backend email routing architecture of Invoice Rescue against the requirements of **Milestone M4: Edge Infrastructure & Deliverability Controls (R4)**. 

The system relies on a **split-trust dual-binding model** using Cloudflare Worker `send_email` bindings:
1. **`NOTIFY`**: Hard-restricted at the Cloudflare edge to the operator's verified inbox (`destination_address: "tiborcc2@gmail.com"`).
2. **`SEND`**: Unrestricted destination binding reserved for authenticated outbound communications to debtors (chase notices) and clients (magic login links, weekly cash digests).

### Key Findings:
- **Split-Trust Integrity**: The system correctly separates operator alerts (`NOTIFY`) from external communications (`SEND`). In all current call sites, `NOTIFY` is never targeted to a debtor, and `SEND` is never used for internal operator notifications. The locked sender model (`hello@invoicerescue.co.uk` signed by Tibor Rames on behalf of the client) is strictly honored in debtor chase drafts.
- **Architectural Gap (Contract Violation)**: `PROJECT.md` Interface Contract 5 mandates a centralized delivery module `backend/src/lib/email.ts` providing `sendOperatorNotification()` and `sendDebtorCommunication()`. This file **does not exist**. Email sending is currently scattered across 8 direct call sites in `backend/src/index.ts`, `backend/src/lib/chase-runner.ts`, and `backend/src/lib/portal-api.ts`.
- **Deliverability & Anti-Spam Compliance**: All outbound emails pass only basic `{ to, from, subject, text }` fields. Essential RFC deliverability headers are completely missing:
  - `Auto-Submitted: auto-generated` (RFC 3834): Missing from automated notifications, risking mail loops and vacation auto-responder floods.
  - `Message-ID` (RFC 5322) & `Date` (RFC 2822): Missing explicit tracking headers.
  - `Reply-To`: Missing explicit `replyTo: "hello@invoicerescue.co.uk"`.
- **Resilience & Error Handling Vulnerability**: While HTTP route handlers (`handleLead`, `handleStripeWebhook`, `handlePortalLoginRequest`) safely catch email dispatch failures, the scheduled cron runner in `backend/src/lib/chase-runner.ts` contains **two unhandled `env.NOTIFY.send()` calls** (lines 157 and 245). If the email service experiences transient errors or rate limits, the daily cron job crashes prematurely, halting the overdue invoice detection pipeline.
- **Dead / Redundant Route**: `backend/src/index.ts` contains orphaned legacy approval and skip handlers (`handleChaseApprove`, lines 543-589) that shadow the canonical implementation in `backend/src/lib/portal-api.ts`.

---

## 1. Split-Trust Architecture & Routing Verification

### 1.1 Infrastructure Binding Configuration (`wrangler.jsonc`)

In `wrangler.jsonc` (lines 37–50):
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

#### Verification:
1. **Edge Platform Enforcement**:
   - In Cloudflare Workers, configuring `"destination_address": "tiborcc2@gmail.com"` on the `NOTIFY` binding guarantees that Cloudflare's edge mailer rejects any attempt to dispatch mail to any recipient other than `tiborcc2@gmail.com` with a runtime error (`550 / destination address not allowed`).
   - The `SEND` binding has no `destination_address` or `allowed_destination_addresses`, enabling delivery to arbitrary debtor and client email addresses.
2. **Environment Variables**:
   - `NOTIFY_TO`: `"tiborcc2@gmail.com"` (operator inbox destination)
   - `NOTIFY_FROM`: `"hello@invoicerescue.co.uk"` (SPF/DKIM verified sender)
   - `OPERATOR_NAME`: `"Tibor"` (operator signature audit trail)

---

### 1.2 Inventory of Email Call Sites

| # | Location | Function / Event | Binding | Recipient (`to`) | Sender (`from`) | Error Handling | Status |
|---|---|---|---|---|---|---|---|
| 1 | `backend/src/index.ts:345` | `handleLead` (Form submission) | `env.NOTIFY` | `env.NOTIFY_TO` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | `try / catch` (logged) | Compliant |
| 2 | `backend/src/index.ts:803` | `handleStripeWebhook` (`payment_failed`) | `env.NOTIFY` | `env.NOTIFY_TO` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | `try / catch` (logged) | Compliant |
| 3 | `backend/src/lib/chase-runner.ts:157` | `runOverdueDetection` (Stage 4 exhausted) | `env.NOTIFY` | `env.NOTIFY_TO` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | **None** (unhandled) | **Vulnerable** |
| 4 | `backend/src/lib/chase-runner.ts:245` | `runOverdueDetection` (Drafts ready review) | `env.NOTIFY` | `env.NOTIFY_TO` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | **None** (unhandled) | **Vulnerable** |
| 5 | `backend/src/lib/portal-api.ts:755` | `handleApproveDraft` (Approved chase) | `env.SEND` | `row.debtor_email` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM \|\| LOCKED_SENDER_EMAIL }` | Unhandled locally (outer 500) | Transactional (safe state) |
| 6 | `backend/src/index.ts:575` | `handleChaseApprove` (Legacy approval) | `env.SEND` | `row.debtor_email` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | None | **Dead Code** |
| 7 | `backend/src/index.ts:646` | `handlePortalLoginRequest` (Magic link) | `env.SEND` | `email` (Client) | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | `try / catch` (logged) | Compliant |
| 8 | `backend/src/index.ts:866` | `runFridayReport` (Weekly cash report) | `env.SEND` | `client.contact_email` | `{ name: SENDER_NAME, email: env.NOTIFY_FROM }` | `try / catch` per client | Compliant |

---

### 1.3 Locked Sender & Sign-off Model Verification

The system enforces a strict sender identity model for all debtor-facing communications:
1. **Header Sender**:
   - `from.name`: `"Invoice Rescue"` (`SENDER_NAME`)
   - `from.email`: `"hello@invoicerescue.co.uk"` (`env.NOTIFY_FROM` / `LOCKED_SENDER_EMAIL`)
2. **Draft Message Body Sign-off**:
   Both Gemini AI prompt generation (`backend/src/lib/gemini.ts:66-69`) and procedural fallback generation (`backend/src/lib/chase-runner.ts:64-70`) strictly enforce:
   ```text
   Tibor Rames
   Invoice Rescue — acting on behalf of [Client Business Name]
   hello@invoicerescue.co.uk
   ```
3. **Audit Trail**:
   In `handleApproveDraft` (`backend/src/lib/portal-api.ts:762-773`), when a draft is dispatched, the database records:
   - `chase_log.status = 'sent'`
   - `chase_log.sent_at = datetime('now')`
   - `chase_log.reviewed_at = datetime('now')`
   - `chase_log.reviewed_by = env.OPERATOR_NAME || 'Tibor Rames'`
   This audit trail is surfaced directly to clients in the portal dashboard (`/portal/dashboard`).

---

## 2. Deliverability Controls & Anti-Spam Compliance

### 2.1 Domain & SPF / DKIM / DMARC Alignment
- **Apex Domain**: `invoicerescue.co.uk`
- **Sender Address**: `hello@invoicerescue.co.uk`
- **Envelope Return-Path / Mail From**: `cf-bounce.invoicerescue.co.uk`
- **DNS Records**:
  - Outbound email routing is configured through Cloudflare Email Sending.
  - SPF record authorizes Cloudflare mail servers (`include:_spf.mx.cloudflare.net`).
  - DKIM keys are managed by Cloudflare on `cf-bounce.invoicerescue.co.uk` and aligned with `invoicerescue.co.uk`.
  - Inbound MX points to Google Workspace (`aspmx.l.google.com`), ensuring replies to `hello@invoicerescue.co.uk` land directly in Google Workspace without passing through the Worker.

### 2.2 Header Inspection & Anti-Spam Gaps

Every call site currently invokes Cloudflare's `SendEmail.send()` with only four attributes:
```typescript
{
  to: recipient,
  from: { name: "Invoice Rescue", email: "hello@invoicerescue.co.uk" },
  subject: subjectLine,
  text: messageBody
}
```

Cloudflare's `EmailMessageBuilder` type in `worker-configuration.d.ts` (lines 12743–12756) supports:
```typescript
interface EmailReplyMessageBuilder {
    from: string | EmailAddress;
    subject: string;
    replyTo?: string | EmailAddress;
    headers?: Record<string, string>;
    text?: string;
    html?: string;
    attachments?: EmailAttachment[];
}
```

#### Identified Deliverability Deficiencies:
1. **Missing `Auto-Submitted: auto-generated` (RFC 3834)**:
   - Automated operator alerts (`handleLead`, `handleStripeWebhook`, `runOverdueDetection`) and automated Friday reports (`runFridayReport`) do NOT specify `Auto-Submitted: auto-generated`.
   - **Risk**: Without this header, if an operator or client has an automated responder (vacation / out-of-office autoreply), receipt of the notification can trigger an automated response back to `hello@invoicerescue.co.uk`, causing an email loop.
2. **Missing `Message-ID` & `Date` (RFC 5322 / RFC 2822)**:
   - No explicit `Message-ID` header is passed. While Cloudflare's edge mailer generates a default message ID, generating an explicit domain-specific Message-ID (e.g. `<${crypto.randomUUID()}@invoicerescue.co.uk>`) provides end-to-end trace correlation in server logs.
   - An explicit RFC 2822 `Date` header prevents mail client timestamp misinterpretation across different edge timezones.
3. **Missing Explicit `Reply-To`**:
   - Outbound debtor communications do not set `replyTo: "hello@invoicerescue.co.uk"`. While the `From:` header is `hello@invoicerescue.co.uk`, explicit `replyTo` guarantees that enterprise mail filters and custom clients route replies to the primary inbox rather than bounce envelope addresses.
4. **MIME Structure**:
   - All messages are dispatched as single-part plain text (`text/plain`).
   - Plain text is optimal for debt collection: zero spam penalty from image trackers or CSS stylesheets, high readability, and authentic human appearance.
   - However, plain text formatting must ensure uniform newline normalization so text does not render concatenated in older email clients.

---

## 3. Error Handling, Binding Availability & Resilience

### 3.1 Resilience Analysis by Route

| Subsystem | Failure Scenario | Current Behavior | Resilience Assessment |
|---|---|---|---|
| `handleLead` | `env.NOTIFY.send` throws | Caught in `try / catch`; error logged to console; HTTP 200 returned; lead preserved in D1. | **High** |
| `handleStripeWebhook` | `env.NOTIFY.send` throws | Caught in `try / catch`; error logged; HTTP 200 returned to Stripe; event recorded. | **High** |
| `handlePortalLoginRequest` | `env.SEND.send` throws | Caught in `try / catch`; error logged; "Sent" screen displayed to user without leaking failure. | **High** |
| `runFridayReport` | `env.SEND.send` throws for client X | Caught inside client loop; error logged; loop continues to client Y. | **High** |
| `runOverdueDetection` (Stage 4 Alert) | `env.NOTIFY.send` throws | **Unhandled exception**. Halts `runOverdueDetection` execution mid-loop. Subsequent overdue invoices are skipped. | **CRITICAL BUG** |
| `runOverdueDetection` (Review Digest) | `env.NOTIFY.send` throws | **Unhandled exception**. Halts scheduled handler after drafts were created. | **Medium Bug** |
| `handleApproveDraft` | `env.SEND.send` throws | Not caught locally. Bubbles to outer `index.ts` catch block; returns HTTP 500. `chase_log` status remains `draft` (safe state, draft is not falsely marked sent). | **Moderate** (Transactional, but poor UX) |

### 3.2 Missing or Undefined Environment Bindings

If `env.SEND` or `env.NOTIFY` is `undefined` (e.g. running locally via `wrangler dev` without bindings configured, or in a lightweight test environment):
- Calling `env.NOTIFY.send()` immediately throws:
  `TypeError: Cannot read properties of undefined (reading 'send')`
- There is currently **no defensive check** or mock fallback for local development and non-production runners.

---

## 4. Identified Gaps, Leakages & Cross-Contamination Risks

### 4.1 Gap 1: Missing Centralized `backend/src/lib/email.ts` Module
`PROJECT.md` Feature 21 and Interface Contract 5 state:
```typescript
// Interface Contract 5: Email Deliverability & Split-Trust (deliverability)
sendOperatorNotification(env: Env, subject: string, body: string): Promise<void> // uses env.NOTIFY
sendDebtorCommunication(env: Env, to: string, subject: string, body: string): Promise<void> // uses env.SEND
```
- **Finding**: This file is completely absent from the codebase. Email sending is duplicated across `backend/src/index.ts`, `backend/src/lib/chase-runner.ts`, and `backend/src/lib/portal-api.ts`.
- **Impact**: Code duplication, inconsistent error handling, lack of boundary enforcement, and failure to inject deliverability headers.

### 4.2 Gap 2: In-Memory Test Mock Blind Spot
- In `tests/e2e/harness.ts` (lines 13–23), `MockEmailBinding` records any email sent to `this.sent`.
- It does **not** validate whether `this.sent` on `env.NOTIFY` conforms to `destination_address: "tiborcc2@gmail.com"`.
- If a regression in source code causes `env.NOTIFY.send({ to: debtorEmail })`, the mock test suite will pass without failure unless an explicit test assertion checks `notify.sent.length === 0`.

### 4.3 Gap 3: Dead Code in `backend/src/index.ts`
- `backend/src/index.ts` lines 543–589 contains `handleChaseApprove`, which also sends via `env.SEND`.
- However, router line 284 routes `/api/chase/:id/approve` and `/api/admin/drafts/:id/approve` to `handleApproveDraft` from `backend/src/lib/portal-api.ts`.
- `handleChaseApprove` in `index.ts` is never called. It lacks the multi-tenant client session boundary check present in `portal-api.ts`.

### 4.4 Gap 4: Debtor Email Syntax Validation
- In `handleApproveDraft` (`backend/src/lib/portal-api.ts:718`), the code checks:
  ```typescript
  if (!row.debtor_email) {
    return Response.json({ ok: false, error: "Invoice has no debtor email on file." }, { status: 422 });
  }
  ```
- It does not validate RFC 5322 email syntax or reject loopback/operator addresses before calling `env.SEND.send()`.

---

## 5. Architectural Recommendations & Implementation Plan for M4

To satisfy Milestone M4 and close all identified gaps, the following implementation strategy is recommended:

### 5.1 Implement `backend/src/lib/email.ts`

Create `backend/src/lib/email.ts` conforming strictly to `PROJECT.md` Interface Contract 5, featuring:
1. **Split-Trust Routing Enforcement**:
   - `sendOperatorNotification`: Strictly asserts `env.NOTIFY` binding. Rejects any attempt to specify a non-operator recipient. Sets `Auto-Submitted: auto-generated`. Catches errors gracefully so caller workflows are not disrupted.
   - `sendDebtorCommunication`: Strictly asserts `env.SEND` binding. Validates recipient syntax. Enforces locked sender identity (`Invoice Rescue <hello@invoicerescue.co.uk>`) and `replyTo: "hello@invoicerescue.co.uk"`.
   - `sendClientCommunication`: Dispatches magic login links and Friday reports via `env.SEND`.
2. **Standardized Header Generation**:
   Injects:
   - `Message-ID: <${crypto.randomUUID()}@invoicerescue.co.uk>`
   - `Date: ${new Date().toUTCString()}`
   - `Auto-Submitted: auto-generated` (for operator alerts and cron reports)
   - `X-Mailer: Invoice-Rescue-Edge-Mailer/1.0`
   - `Reply-To: hello@invoicerescue.co.uk`
3. **Defensive Binding Fallback**:
   If `env.NOTIFY` or `env.SEND` is unavailable (e.g. unit tests or local dev without mock), log a structured warning rather than throwing an unhandled `TypeError`.

### 5.2 Implementation Sketch for `backend/src/lib/email.ts`

```typescript
/**
 * Invoice Rescue — Split-Trust Email Delivery Module (Milestone M4)
 */

export const SENDER_NAME = "Invoice Rescue";
export const LOCKED_SENDER_EMAIL = "hello@invoicerescue.co.uk";
export const OPERATOR_INBOX_EMAIL = "tiborcc2@gmail.com";

export interface EmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Validates basic RFC 5322 email syntax.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Dispatches an internal operator alert strictly through env.NOTIFY.
 * Automatically injects Auto-Submitted: auto-generated to prevent mail loops.
 */
export async function sendOperatorNotification(
  env: Env,
  subject: string,
  body: string,
): Promise<EmailResult> {
  const destination = env.NOTIFY_TO || OPERATOR_INBOX_EMAIL;
  const senderEmail = env.NOTIFY_FROM || LOCKED_SENDER_EMAIL;
  const messageId = `<${crypto.randomUUID()}@invoicerescue.co.uk>`;

  if (!env.NOTIFY || typeof env.NOTIFY.send !== "function") {
    console.warn("sendOperatorNotification: env.NOTIFY binding unavailable; skipping send.");
    return { ok: false, error: "NOTIFY binding unavailable" };
  }

  try {
    await env.NOTIFY.send({
      to: destination,
      from: { name: SENDER_NAME, email: senderEmail },
      subject,
      text: body,
      headers: {
        "Message-ID": messageId,
        "Date": new Date().toUTCString(),
        "Auto-Submitted": "auto-generated",
        "X-Mailer": "Invoice-Rescue-Edge-Mailer/1.0",
      },
    });
    return { ok: true, messageId };
  } catch (err) {
    console.error("sendOperatorNotification failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dispatches an authenticated debtor communication strictly through env.SEND.
 * Enforces locked sender identity and reply-to routing.
 */
export async function sendDebtorCommunication(
  env: Env,
  to: string,
  subject: string,
  body: string,
): Promise<EmailResult> {
  if (!to || !isValidEmail(to)) {
    throw new Error(`Invalid debtor email address: ${to}`);
  }

  const senderEmail = env.NOTIFY_FROM || LOCKED_SENDER_EMAIL;
  const messageId = `<${crypto.randomUUID()}@invoicerescue.co.uk>`;

  if (!env.SEND || typeof env.SEND.send !== "function") {
    console.warn("sendDebtorCommunication: env.SEND binding unavailable; skipping send.");
    return { ok: false, error: "SEND binding unavailable" };
  }

  await env.SEND.send({
    to: to.trim(),
    from: { name: SENDER_NAME, email: senderEmail },
    replyTo: senderEmail,
    subject,
    text: body,
    headers: {
      "Message-ID": messageId,
      "Date": new Date().toUTCString(),
      "X-Mailer": "Invoice-Rescue-Edge-Mailer/1.0",
    },
  });

  return { ok: true, messageId };
}
```

### 5.3 Refactoring Plan for M4 Implementer
1. **Create `backend/src/lib/email.ts`** with unit test suite in `tests/email.test.ts`.
2. **Refactor Call Sites**:
   - Update `backend/src/index.ts` (`handleLead`, `handleStripeWebhook`, `handlePortalLoginRequest`, `runFridayReport`) to use `email.ts`.
   - Remove dead code `handleChaseApprove` and `handleChaseSkip` in `backend/src/index.ts`.
   - Update `backend/src/lib/chase-runner.ts` (lines 157 and 245) to call `sendOperatorNotification()`, resolving the cron crash vulnerability.
   - Update `backend/src/lib/portal-api.ts` (`handleApproveDraft`) to call `sendDebtorCommunication()`.
3. **Harden Test Harness**:
   - Update `MockEmailBinding` in `tests/e2e/harness.ts` to simulate Cloudflare's `destination_address` restriction when configured as `NOTIFY`.
4. **Verification**:
   - Run `npx tsc --noEmit` and `npm test`.
   - Verify `wrangler deploy --dry-run`.
