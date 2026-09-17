# TEST_READY: Invoice Rescue End-to-End Test Suite

## Executive Summary

The comprehensive, opaque-box End-to-End (E2E) test suite for the Invoice Rescue Credit-Control SaaS platform has been designed, implemented, and validated. The suite rigorously verifies the entire system against specifications in `ORIGINAL_REQUEST.md`, `PROJECT.md`, and `TEST_INFRA.md` without modifying any production code.

- **Total Repo Tests**: 306 passing tests (249 E2E tests + 57 unit/integration tests)
- **E2E Test Suites**: 4 test tiers + 1 shared in-memory test harness
- **Typecheck Result**: Clean compilation (`tsc --noEmit` exits code 0)
- **Execution Performance**: Full test suite runs in ~4.0 seconds via native Node test runner (`node:test`) and `tsx`

---

## Quick Verification Commands

### Run Full Test Suite (E2E + Unit Tests)

```bash
npm test
```

### Run Dedicated E2E Test Suite Only

```bash
npx tsx --test tests/e2e/**/*.test.ts
```

### Run Typecheck / Static Analysis

```bash
npm run typecheck
```

---

## Test Architecture & Harness

Located in `tests/e2e/harness.ts`:

- **In-Memory D1 SQLite Engine**: Uses Node.js 25's `node:sqlite.DatabaseSync(":memory:")` implementing the full Cloudflare `D1Database` and `D1PreparedStatement` interface (`prepare`, `bind`, `first`, `all`, `run`, `batch`, `exec`).
- **Automated Schema Migration**: Dynamically executes all production D1 migrations (`0001_initial_schema.sql` through `0006_accounting_connections_and_external_sync.sql`) ensuring strict schema parity with production Cloudflare D1.
- **Split-Trust Mock Email Bindings**: Intercepts and logs outbound mail for both `NOTIFY` (operator alerts) and `SEND` (debtor reminders, magic links, Friday reports) to independently verify recipient segregation.
- **Cryptographic Test Signers**:
  - `signHmacSha256Base64`: RFC 2104 HMAC-SHA256 with Base64 encoding for Xero (`x-xero-signature`) and QuickBooks (`intuit-signature`).
  - `signStripeWebhook`: Hex-encoded HMAC-SHA256 signature with `t={timestamp},v1={hex}` format and replay tolerance compliance.
  - `generatePortalSessionCookie`: Creates valid or tampered HMAC-SHA256 session cookies for client authentication testing.

---

## Test Suite Inventory & Coverage

### Tier 1: Feature Coverage (`tests/e2e/tier1-features.test.ts`)

- **Coverage**: 110 test cases (5 tests each across all 22 features, F1–F22)
- **Scope**: Primary functional contracts (happy path) isolated per requirement:
  - F1: Multi-tenant data isolation & separate ledgers
  - F2: OAuth 2.0 connection lifecycle (connect, callback, refresh, revoke, disconnect)
  - F3: Token encryption at rest via AES-GCM-256 with 96-bit IV
  - F4: Webhook HMAC signature verification (Stripe, Xero, QuickBooks)
  - F5: Webhook deduplication & idempotency tracking
  - F6: Accounting ingestion & incremental sync
  - F7: Ingestion daily polling cron (06:00 UTC)
  - F8: 4-stage escalation cadence (Days 1, 8, 15, 22)
  - F9: Terminal escalation states (paid, disputed, handed back, skipped)
  - F10: Statutory interest calculation (BoE Base Rate + 8% per annum)
  - F11: Statutory compensation tiers (£40 under £1k, £70 under £10k, £100 at £10k+)
  - F12: Locked sender model & sign-off attribution (Tibor Rames / Invoice Rescue)
  - F13: AI chase draft generation & review queue staging
  - F14: Executive financial dashboard & client portal
  - F15: Debtor ledger filtering, pagination, and multi-field search
  - F16: WCAG 2.2 AA accessibility (headings, labels, tables, contrast)
  - F17: Review queue draft body editing before sending
  - F18: Review queue approval and deferral transitions
  - F19: Responsive design tokens and theming support
  - F20: Zero-runtime-dependency Cloudflare Workers edge architecture
  - F21: Split-trust outbound email routing (`NOTIFY` vs `SEND`)
  - F22: D1 database schema integrity and foreign key constraints

### Tier 2: Boundary & Corner Cases (`tests/e2e/tier2-boundaries.test.ts`)

- **Coverage**: 110 test cases (5 boundary tests per feature across F1–F22)
- **Scope**: Rigorous edge conditions and adversarial inputs:
  - Zero-drift non-compounding interest formulas across leap years (366 days)
  - Exact compensation thresholds (£999.99 vs £1,000.00, £9,999.99 vs £10,000.00)
  - Replay attacks, expired webhook timestamps (>300s), and corrupted base64/hex signatures
  - Boundary day counts (due today: 0 days, due tomorrow: -1 days)
  - Empty bodies, oversized payload handling (2,000+ character drafts), and Windows CRLF normalizations
  - Database schema CHECK constraint violations and SQL injection defenses

### Tier 3: Pairwise Combinatorial Interactions (`tests/e2e/tier3-pairwise.test.ts`)

- **Coverage**: 24 interaction tests (exceeding ≥22 requirement)
- **Scope**: Cross-feature interactions and concurrent operations:
  - P1: Payment webhook arrives while draft is pending in review queue -> draft is skipped, invoice marked paid
  - P2: CSV import with existing invoice number for same client rejects duplicate insert
  - P3: CSV import with identical invoice number for DIFFERENT client succeeds cleanly isolating both records
  - P4: Token encryption with OAuth connection rotation overwrites old tokens seamlessly
  - P5: Daily cron overdue detection runs while webhook updates invoice status concurrently
  - P6: Webhook deduplication during rapid duplicate stripe subscription updates triggers only once
  - P7: Out-of-order webhook delivery preserves newer state without downgrading
  - P8: Magic link login verification while client status is onboarding generates session cookie
  - P9: Admin approves draft while operator name contains special characters
  - P10: Review queue skip action followed by subsequent daily cron maintains cadence
  - P11: Statutory interest calculation updates dynamically when principal debt changes
  - P12: Statutory interest calculation combined with leap year date math across 2024 / 2028
  - P13: Client portal dashboard segregates invoices ledger from chase audit log
  - P14: Split-trust routing during daily cron: operator notification sent via NOTIFY while no debtor messages sent without approval
  - P15: Admin edits draft text to include custom payment link -> edited text preserved in chase_log and sent via SEND
  - P16: Client onboarded via admin API immediately imports CSV invoices successfully
  - P17: Stripe webhook sets client status to churned -> client record updated
  - P18: Ingestion sync marks invoice disputed -> staged draft suppressed
  - P19: OAuth connection status updated to revoked upon invalid_grant response
  - P20: High volume debtor search while draft review is active executes concurrently
  - P21: Stage 4 final notice expires without payment -> terminal state reached
  - P22: Theme switching and navigation preserves portal session cookie
  - P23: CSV import with special characters in debtor name correctly stores for prompt construction
  - P24: Multiple clients with different BOE base rates applied calculates correctly

### Tier 4: Real-World Application Workload Scenarios (`tests/e2e/tier4-scenarios.test.ts`)

- **Coverage**: 5 comprehensive end-to-end lifecycle scenarios
- **Scope**: Complete multi-step workflows:
  1. **Multi-Tenant Agency Full Recovery Lifecycle**:
     Admin onboards agency -> CSV invoice imported -> 06:00 UTC cron stages S1 draft -> Admin approves draft with custom note -> Outbound debtor email delivered -> Debtor pays via Stripe -> Webhook marks invoice paid -> Portal reflects verified payment and audit history.
  2. **Duplicate Webhook Ingestion During Draft Approval**:
     Overdue invoice generates Stage 2 draft -> Debtor settles debt -> Two identical payment webhooks arrive simultaneously -> First webhook processes and skips pending draft; duplicate is suppressed -> Admin attempt to approve skipped draft is rejected with HTTP 404.
  3. **Leap Year & Multi-Year Debt Accumulation**:
     Invoice overdue across leap year boundary (2024) -> Accrues daily interest with 366-day denominator -> Moves into 2025 -> Compensation tier correctly calculated -> Staged Stage 3 draft contains exact cumulative interest and compensation figures -> Client inspects dashboard with formatted totals.
  4. **Token Rotation, Revocation & Re-Authentication Lifecycle**:
     Client connects Xero -> Access/refresh tokens stored encrypted -> Refresh rotation occurs -> Provider returns `invalid_grant` -> Connection flagged `revoked` -> Scheduled polling logs re-auth requirement -> Client re-authenticates and active sync resumes.
  5. **Full 4-Stage Cadence Escalation to Hand-Back with Final Settlement**:
     Invoice progresses through Stage 1 (Gentle), Stage 2 (Firm), Stage 3 (Final Notice with Fees), to Stage 4 (Formal Pre-Action) -> 7 days elapse post Stage 4 -> Invoice transitions to `handed_back` -> Debtor settles outstanding debt -> Manual reconciliation marks invoice `paid` -> Escalation terminates.

---

## Pass/Fail Verification Matrix

| Test Suite | Files | Tests | Pass | Fail | Skip | Duration |
| ------------ | ------- | :-----: | :----: | :----: | :----: | :--------: |
| **Tier 1: Feature Coverage** | `tests/e2e/tier1-features.test.ts` | 110 | 110 | 0 | 0 | ~1.02s |
| **Tier 2: Boundary & Corners** | `tests/e2e/tier2-boundaries.test.ts` | 110 | 110 | 0 | 0 | ~1.10s |
| **Tier 3: Pairwise Interactions** | `tests/e2e/tier3-pairwise.test.ts` | 24 | 24 | 0 | 0 | ~0.83s |
| **Tier 4: Workload Scenarios** | `tests/e2e/tier4-scenarios.test.ts` | 5 | 5 | 0 | 0 | ~0.81s |
| **Unit & Integration Suites** | `tests/*.test.ts` | 57 | 57 | 0 | 0 | ~0.32s |
| **TOTAL** | | **306** | **306** | **0** | **0** | **~4.08s** |

All tests pass cleanly with zero warnings, zero deprecation notices, and zero leaked timers.
