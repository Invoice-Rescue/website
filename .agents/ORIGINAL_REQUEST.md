# Original User Request

## 2026-09-16T05:04:41Z

Build an end-to-end, multi-tenant B2B credit-control SaaS on Cloudflare (Workers, D1 SQLite, Pages) that automates invoice synchronization from accounting providers (Xero, QuickBooks), executes a 4-stage statutory late-payment escalation state machine, and provides an interactive human-in-the-loop review portal.

Working directory: d:\Dev\Workspaces\Active\invoice-rescue
Integrity mode: demo

## Requirements

### R1. Multi-Tenant Data Architecture & Accounting Synchronization
Provide a multi-tenant database layer isolating tenant organizations, managing OAuth 2.0 connection lifecycles for Xero and QuickBooks with secure token encryption at rest, and implementing cryptographic webhook handlers and daily polling jobs to continuously ingest and reconcile unpaid debtor invoices.

### R2. Credit-Control Escalation & Statutory Calculation Engine
Provide an automated invoice aging engine that transitions overdue invoices across four distinct stages (Gentle, Follow-up, Firm notice, Final demand), dynamically calculates statutory interest (Bank of England base rate + 8%) and statutory late fees (£40/£70/£100) under the UK Late Payment of Commercial Debts Act 1998, and generates stage-appropriate chase drafts adhering to verified sender constraints (`FROM: hello@invoicerescue.co.uk`).

### R3. Client Portal & Human-in-the-Loop Review Queue
Deploy a responsive web interface featuring an executive financial dashboard (overdue totals, aging breakdown gauge, active recovery pipeline), an accessible debtor ledger table with search and filtering, and an interactive draft-approval queue allowing operators and clients to inspect statutory claim breakdowns, edit messages in-place, approve sending, or defer chasing.

### R4. Edge Infrastructure & Deliverability Controls
All backend services and endpoints must run on the Cloudflare Workers edge runtime backed by Cloudflare D1 with zero external runtime package dependencies. Email delivery must enforce split-trust routing (`NOTIFY` operator alerts, `SEND` authenticated debtor communications) and avoid anti-bot or deliverability penalties.

## Acceptance Criteria

### Data Layer & Integrations
- [ ] Multi-tenancy isolation guarantees that queries for one client or tenant cannot read or modify another tenant's invoices or connections.
- [ ] OAuth tokens for accounting integrations are encrypted at rest using Web Crypto AES-GCM (256-bit).
- [ ] Webhook verification strictly validates cryptographic HMAC signatures for both Xero and QuickBooks, rejecting tampered or unverified payloads.
- [ ] Ingestion logic deduplicates webhook events and syncs invoice status changes (e.g. marking invoices paid) idempotently.

### Escalation & State Machine
- [ ] Escalation logic strictly follows the 4-stage cadence:
  - Stage 1 (Gentle): 1+ days overdue.
  - Stage 2 (Follow-up): 7+ days after Stage 1.
  - Stage 3 (Firm): 7+ days after Stage 2 (with statutory notice).
  - Stage 4 (Final): 7+ days after Stage 3 (7-day hand-back notice).
  - Terminal states (`paid`, `handed_back`) receive no further automated chases.
- [ ] Statutory interest calculation matches statutory formula without rounding drift.
- [ ] Generated drafts strictly maintain the locked sender model (`hello@invoicerescue.co.uk`, signed by Tibor Rames on behalf of the client).

### User Interface & Accessibility
- [ ] Debtor ledger table supports instant debounced search and filtering by stage/status, and complies with WCAG 2.2 Level AA accessibility standards.
- [ ] Draft approval queue displays full statutory financial calculations, editable draft text, and functional "Approve & Send" and "Skip/Defer" actions.
- [ ] Interface supports both dark and light modes with responsive layouts for mobile and desktop.

### Quality & Verification Gate
- [ ] TypeScript type checks pass with zero errors (`npx tsc --noEmit`).
- [ ] Automated unit and integration test suite runs and passes 100% (`npm test`).
- [ ] Worker dry-run deployment bundles cleanly without errors (`npm run build`).
- [ ] Database migrations apply successfully to local D1 (`npx wrangler d1 migrations apply invoice-rescue-db --local`).
