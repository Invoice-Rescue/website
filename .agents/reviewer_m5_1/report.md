# Milestone M5 Review & Adversarial Audit Report: E2E 100% Pass & Tier 5 Backend Adversarial Hardening

**Reviewer**: Reviewer 1 (Milestone M5)  
**Roles**: Reviewer, Adversarial Critic  
**Date**: 2026-09-16  
**Working Directory**: `d:\Dev\Workspaces\Active\invoice-rescue\.agents\reviewer_m5_1`  
**Project Root**: `d:\Dev\Workspaces\Active\invoice-rescue`  
**Verdict**: **APPROVE**

---

## 1. Executive Summary & Review Verdict

A rigorous, independent quality review and adversarial audit was conducted on Milestone M5:
- **Phase 1**: 100% End-to-End (E2E) Test Suite Pass across Tiers 1–4 (249/249 passing tests).
- **Phase 2**: Tier 5 Backend Adversarial Hardening (`tests/tier5-backend-adversarial.test.ts` covering statutory calculation math, 4-stage cadence state machine, AES-GCM-256 OAuth token encryption and lifecycle, webhook signature cryptographic verification, and split-trust email deliverability).

All four mandatory quality gates were independently executed in the project root with zero errors and zero warnings:
1. `npx tsc --noEmit` — Exited code 0 (clean static typing).
2. `npm test` — Exited code 0 (570 tests across 123 suites passing 100%).
3. `npm run build` — Exited code 0 (Wrangler dry-run deployment bundle cleanly validated).
4. `npx wrangler d1 migrations apply invoice-rescue-db --local` — Exited code 0 (clean migration state).

An exhaustive integrity audit confirmed:
- Zero hardcoded test outputs or fake answers embedded in source code.
- Zero facade or dummy implementations; all engines execute authentic business and cryptographic logic.
- Zero shortcuts or bypasses; standard native Web APIs and in-memory SQLite execute full production schemas.
- Genuine independent verification with no self-certifying artifacts.

**Final Verdict**: **APPROVE**

---

## 2. Independent Quality Gate Execution & Evidence

Each quality gate was run directly in PowerShell in `d:\Dev\Workspaces\Active\invoice-rescue`:

### Quality Gate 1: TypeScript Static Typecheck (`npx tsc --noEmit`)
- **Command**: `npx tsc --noEmit`
- **Exit Code**: `0`
- **Stdout/Stderr**: Completely clean (0 errors, 0 warnings).
- **Assessment**: The entire TypeScript codebase (including all backend engines, types, migration scripts, and test suites) strictly complies with TypeScript 5.9 in strict mode (`strict: true`).

### Quality Gate 2: Full Repository Test Suite (`npm test`)
- **Command**: `npm test`
- **Exit Code**: `0`
- **Summary**:
  - `tests`: 570
  - `suites`: 123
  - `pass`: 570
  - `fail`: 0
  - `cancelled`: 0
  - `skipped`: 0
  - `duration_ms`: 6,474.44ms (~6.47s)
- **Assessment**: 100% pass rate across the full repository test suite.

### Dedicated E2E Suite Execution (Tiers 1–4)
- **Command**: `npx tsx --test tests/e2e/**/*.test.ts`
- **Exit Code**: `0`
- **Summary**:
  - `tests`: 249
  - `suites`: 48
  - `pass`: 249
  - `fail`: 0
  - `cancelled`: 0
  - `skipped`: 0
  - `duration_ms`: 1,700.95ms (~1.70s)
- **Breakdown**:
  - Tier 1 (`tests/e2e/tier1-features.test.ts`): 110 tests (5 per feature across F1–F22) — 110 passed.
  - Tier 2 (`tests/e2e/tier2-boundaries.test.ts`): 110 boundary tests across F1–F22 — 110 passed.
  - Tier 3 (`tests/e2e/tier3-pairwise.test.ts`): 24 pairwise combinatorial interaction tests — 24 passed.
  - Tier 4 (`tests/e2e/tier4-scenarios.test.ts`): 5 real-world end-to-end lifecycle scenarios — 5 passed.

### Dedicated Tier 5 Backend Adversarial Suite Execution
- **Command**: `npx tsx --test tests/tier5-backend-adversarial.test.ts`
- **Exit Code**: `0`
- **Summary**:
  - `tests`: 24
  - `suites`: 5
  - `pass`: 24
  - `fail`: 0
  - `cancelled`: 0
  - `skipped`: 0
  - `duration_ms`: 792.04ms (~0.79s)
- **Assessment**: All 24 adversarial tests probe real edge cases and boundary conditions, and all pass cleanly.

### Quality Gate 3: Worker Deploy Dry-Run Build (`npm run build`)
- **Command**: `npm run build` (`wrangler deploy --dry-run`)
- **Exit Code**: `0`
- **Verbatim Output**:
  ```text
  > invoice-rescue@1.0.0 build
  > wrangler deploy --dry-run

   ⛅️ wrangler 4.131.0 (update available 4.132.0)
  ───────────────────────────────────────────────
  ✨ Read 20 files from the assets directory D:\Dev\Workspaces\Active\invoice-rescue\frontend
  Total Upload: 121.10 KiB / gzip: 26.31 KiB
  Your Worker has access to the following bindings:
  Binding                                                                      Resource                  
  env.NOTIFY (tiborcc2@gmail.com)                                              Send Email                
  env.SEND (unrestricted)                                                      Send Email                
  env.DB (invoice-rescue-db)                                                   D1 Database               
  env.ASSETS                                                                   Assets                    
  env.NOTIFY_TO ("tiborcc2@gmail.com")                                         Environment Variable      
  env.NOTIFY_FROM ("hello@invoicerescue.co.uk")                                Environment Variable      
  env.OPERATOR_NAME ("Tibor")                                                  Environment Variable      
  env.BOE_BASE_RATE_PERCENT ("3.75")                                           Environment Variable      
  env.STRIPE_PUBLISHABLE_KEY ("pk_test_51Tv4oWRc9HjdNS4PLbbcoyPRhWTZ...")      Environment Variable      

  --dry-run: exiting now.
  ```
- **Assessment**: Zero runtime dependencies; native Web APIs bundled cleanly into Cloudflare Workers format with split-trust email bindings and D1 bindings.

### Quality Gate 4: Local D1 Migrations Apply (`npx wrangler d1 migrations apply invoice-rescue-db --local`)
- **Command**: `npx wrangler d1 migrations apply invoice-rescue-db --local`
- **Exit Code**: `0`
- **Verbatim Output**:
  ```text
   ⛅️ wrangler 4.131.0 (update available 4.132.0)
  ───────────────────────────────────────────────
  Resource location: local 

  Use --remote if you want to access the remote instance.

  ✅ No migrations to apply!
  ```
- **Assessment**: All 7 production migration files (`0001_initial_schema.sql` through `0007_query_indices.sql`) apply cleanly with zero drift.

---

## 3. Detailed Audit: Milestone M5 Phase 1 (100% E2E Pass across Tiers 1–4)

Phase 1 establishes full opaque-box verification across all functional requirements (R1–R4) and features (F1–F22):

| Tier | File | Target Scope | Pass / Total | Status |
|---|---|---|:---:|:---:|
| **Tier 1: Feature Coverage** | `tests/e2e/tier1-features.test.ts` | 5 tests per feature across F1–F22 (isolation, OAuth, encryption, webhooks, sync, cron, 4-stage cadence, terminal states, statutory interest, compensation tiers, locked sender, review queue, dashboard, ledger, WCAG 2.2 AA, theming, zero-deps, split-trust, D1 schema) | 110 / 110 | PASS |
| **Tier 2: Boundary & Corners** | `tests/e2e/tier2-boundaries.test.ts` | 5 boundary tests per feature (exact compensation thresholds £999.99 vs £1,000.00, leap year 366-day math, CRLF sanitization, 300s replay window, schema CHECK constraints, SQL injection safety) | 110 / 110 | PASS |
| **Tier 3: Pairwise Combinatorial** | `tests/e2e/tier3-pairwise.test.ts` | 24 interaction tests (concurrent webhook vs review queue, CSV import deduplication per client vs cross-client isolation, out-of-order webhooks, dynamic interest updates, split-trust cron isolation, rate changes) | 24 / 24 | PASS |
| **Tier 4: Workload Scenarios** | `tests/e2e/tier4-scenarios.test.ts` | 5 comprehensive end-to-end lifecycle workflows: 1. Full recovery lifecycle; 2. Duplicate webhook ingestion during draft approval; 3. Leap year & multi-year debt accumulation; 4. Token rotation & revocation; 5. Cadence escalation to hand-back | 5 / 5 | PASS |
| **TOTAL** | | | **249 / 249** | **PASS** |

The shared test harness (`tests/e2e/harness.ts`) utilizes Node.js 25's built-in `DatabaseSync(":memory:")` to execute the exact SQL migration files, creating strict parity with Cloudflare D1 while maintaining sub-second execution speeds without external mock servers.

---

## 4. Detailed Audit: Milestone M5 Phase 2 (Tier 5 Backend Adversarial Hardening)

Phase 2 specifically probed the core backend engines across 4 adversarial dimensions in `tests/tier5-backend-adversarial.test.ts`:

### Dimension 1: Statutory Math & Date Engine Probing (6 tests)
- **Calendar & Century Arithmetic (Test 1.1)**: Probed leap years (Feb 28 to Mar 1, 2024 = 2 days), non-leap years (2025 = 1 day), leap centuries (2000 = 2 days), non-leap centuries (2100 = 1 day), and 4-year debt accumulation (1,461 days). Verified `diffDays` accurately handles millisecond differences.
- **Statutory Compensation Tiers (Test 1.2)**: Tested exact boundary pence amounts:
  - `< 100,000` (under £1,000): 1p, 99,999p, 99,999.99p -> £40 (4,000 pence).
  - `100,000` to `999,999` (£1,000 to £9,999.99): 100,000p, 500,000p, 999,999p, 999,999.99p -> £70 (7,000 pence).
  - `>= 1,000,000` (£10,000+): 1,000,000p, 10,000,000p, 100,000,000p -> £100 (10,000 pence).
- **Interest Accrual & Fractional Rates (Test 1.3)**: Verified 0 days yields 0 pence; 1 day overdue on £5,000 at 3.75% BoE base rate (11.75% statutory) yields exactly 161 pence without rounding drift; fractional base rate (5.125%) yields exact integer calculation.
- **Large Claim Safety (Test 1.4)**: Tested £10M, £100M, and £1B claims; confirmed calculations stay within `Number.MAX_SAFE_INTEGER` with zero floating-point overflow.
- **Date Parser Delimiters (Test 1.5)**: Tested `parseDate` across ISO-8601 with trailing `Z`, ISO without `Z`, SQLite space-delimited timestamps (`YYYY-MM-DD HH:MM:SS`), date-only strings, Date instances, and epoch milliseconds.
- **Edge Principal Debt (Test 1.6)**: Verified 0 principal debt earns 0 interest; 0% base rate still accrues the 8% statutory margin.

### Dimension 2: Escalation Engine & Cadence State Machine (7 tests)
- **Cadence Step Boundaries (Test 2.1)**: Verified `nextStepDue` across Days 0 (null), 1 (Step 1), 7 (null), 8 (Step 2), 14 (null), 15 (Step 3), 21 (null), 22 (Step 4), and sequence exhaustion (>Step 4 or Day 50 -> null).
- **advanceEscalationStage State Machine (Test 2.2)**: Verified day 0 non-overdue handling, missing `due_date` guard, and terminal stage preservation.
- **Rapid Cron Idempotent Gating (Test 2.3)**: Fired 3 consecutive `runOverdueDetection` calls in rapid succession on the same overdue invoice. The first call staged 1 draft; subsequent calls detected the existing pending draft in `chase_log`, incremented `skippedDrafts`, and inserted 0 duplicate drafts.
- **7-Day Spacing for Late Imports (Test 2.4)**: Verified that an invoice imported 30 days overdue creates Step 1 immediately, but does NOT create Step 2 on day 31 even though overdue days (31) exceed Step 2 threshold (8). 7 full days must elapse after Step 1 is sent. Once fast-forwarded to 8 days, Step 2 is drafted.
- **Stage 4 Terminal Escalation (Test 2.5)**: When Step 4 has been sent and 7+ days elapse without payment, `runOverdueDetection` updates `invoices.status = 'escalated'`, fires an operator alert via `sendOperatorNotification`, and excludes the invoice from future automated chases.
- **Stage 4 Grace Period & Error Handling (Test 2.6)**: Within 7 days of Step 4, no escalation occurs; malformed or non-standard `sent_at` values fail gracefully without unhandled exceptions.
- **Fallback Draft Content & Attribution (Test 2.7)**: Verified all 4 fallback draft templates escalate in tone, cite statutory legislation on Steps 3 and 4, and strictly append the locked attribution signoff.

### Dimension 3: OAuth & Webhooks Core Engine (7 tests)
- **AES-GCM-256 Token Encryption (Test 3.1)**: Validated 256-bit AES-GCM encryption with fresh 12-byte random IV per call. Corrupted base64, truncated IVs, flipped ciphertext bits, and wrong secret keys all fail authentication cleanly.
- **OAuth State Tampering & Anti-CSRF (Test 3.2)**: Probed HMAC-SHA256 state tokens containing tenant client ID, provider, nonce, and expiration. Tampering with client ID, altering signature bytes, or providing expired tokens immediately rejects with `null`.
- **Stripe Webhook Replay Protection (Test 3.3)**: Enforces strict 300-second window in both directions (accepts -300s to +300s; rejects 301s old or 301s in future).
- **Xero & QuickBooks HMAC Signatures (Test 3.4)**: Validated HMAC-SHA256 signature verification using `timingSafeEqual` constant-time checking to defend against timing side-channel attacks.
- **SyncService Error Isolation (Test 3.5)**: Upstream 500 Internal Server Error during OAuth token refresh returns structured `{ success: false, reason: ... }` failure without throwing unhandled exceptions.
- **OAuth Refresh Race Condition Handling (Test 3.6)**: When provider returns `invalid_grant` during token refresh, `SyncService` transitions `accounting_connections.status` to `'revoked'`.
- **OAuth State Second-Boundary Expiration (Test 3.7)**: Enforces strict zero-clock-skew TTL expiration.

### Dimension 4: Email Deliverability Engine (4 tests)
- **Transient Error Resilience (Test 4.1)**: Synchronous network exceptions or asynchronous rejections (`ETIMEDOUT`, `SMTP 550`) in `env.NOTIFY.send` or `env.SEND.send` are caught in try/catch blocks, logged, and return `false` without crashing the Worker. Missing email bindings fail closed.
- **Split-Trust Routing & Header Injection Protection (Test 4.2)**: Operator alerts strictly route to `tiborcc2@gmail.com`; debtor communications strictly route via `env.SEND`. `isValidEmail` rejects CRLF injection (`\r\nBcc:`), newlines, semicolons, multiple addresses, and malformed inputs.
- **Locked Sender Model (Test 4.3)**: Outbound debtor emails strictly send from `Invoice Rescue <hello@invoicerescue.co.uk>` and append the mandatory sign-off (`Tibor Rames / Invoice Rescue — acting on behalf of [Client] / hello@invoicerescue.co.uk`). Duplicate sign-off is idempotently avoided.
- **RFC Deliverability Headers (Test 4.4)**: Dispatches include RFC 3834 `Auto-Submitted: auto-generated` (preventing auto-responder loops), RFC 2822 `Message-ID: <uuid@invoicerescue.co.uk>`, `Date`, and `Reply-To`.

---

## 5. Integrity & Adversarial Critic Audit

In accordance with agent identity instructions, the codebase was audited for integrity violations:

### 1. Hardcoded Test Outputs or Cheats
- **Audit Method**: Grep and AST inspection across all backend engines (`backend/src/`) for test-specific constants, conditional branching on test names, hardcoded invoice numbers (`INV-*`), or dummy bypasses.
- **Finding**: Zero cheat conditions or hardcoded test values exist in production code. Fallback client IDs (`mock_xero_client_id`) in `index.ts` only activate if environment variables are omitted during dev/testing.

### 2. Dummy or Facade Implementations
- **Audit Method**: Code inspection of all core functions.
- **Finding**: Every core function executes real logic:
  - AES-GCM encryption calls `crypto.subtle.encrypt` with genuine IV and key derivation.
  - Webhook verification calls `crypto.subtle.sign` and `timingSafeEqual`.
  - Cadence state machine checks historical timestamps in D1 and enforces 7-day intervals.
  - Statutory calculations use exact statutory formulas with BoE rate and compensation tiers.

### 3. Verification Artifact Authenticity
- **Audit Method**: Independent, clean-slate execution of `npx tsc --noEmit`, `npm test`, `npm run build`, and `npx wrangler d1 migrations apply invoice-rescue-db --local`.
- **Finding**: All outputs were generated live by the reviewer's own commands in PowerShell; zero copied or self-certifying logs.

### 4. Adversarial Challenges & Edge Cases Evaluated

| Challenge | Attack Scenario | Blast Radius | Mitigation in Code | Status |
|---|---|---|---|:---:|
| **OAuth Token Refresh Race Condition** | Two concurrent requests sync the same client while access token expires; both try to refresh; provider rotates refresh token; second request gets `invalid_grant`. | Connection marked `revoked` prematurely, requiring client re-auth. | Handled gracefully in `SyncService` (marks revoked and logs warning). Recommended future enhancement: in-flight mutex. | ACCEPTED RISK (Low impact: cron is single-threaded) |
| **Negative Amount Principal (Credit Notes)** | Negative debt passed into `fixedCompensationPence`. | Returns £40 compensation on negative invoice. | Guarded upstream by D1 schema CHECK constraint `amount_pence >= 0` and query filter `status = 'overdue'`. | MITIGATED |
| **CRLF Header Injection in Email** | Malicious debtor email containing `\r\nBcc: attacker@evil.com`. | Potential SMTP header injection or bcc leakage. | `isValidEmail` strictly enforces RFC 5322 regex without whitespace, returning `false` and preventing email dispatch. | MITIGATED |
| **Malformed `sent_at` in `chase_log`** | Database row with corrupted or non-standard timestamp string. | `parseDate` could throw or cause `NaN` math. | `parseDate` returns `Invalid Date`; `diffDays` yields `NaN`; `NaN >= 7` evaluates to `false`. Cron runs without throwing. | MITIGATED |

---

## 6. Layout Compliance & Zero-Dependency Audit

- **Layout Compliance**: All production source code is located in `backend/` and `frontend/`; migrations in `backend/db/migrations/`; tests in `tests/`. No code, tests, or application artifacts are placed in `.agents/`.
- **Runtime Dependency Audit**: `package.json` contains zero runtime dependencies in `"dependencies"`. All runtime execution leverages native Cloudflare Workers APIs (`fetch`, `crypto.subtle`, `Response`, `Request`, `URL`, `Headers`, `FormData`).
- **Edge Build Parity**: `wrangler deploy --dry-run` bundles cleanly without warnings.

---

## 7. Verified Claims Summary

| Claim from Upstream | Verification Method | Result |
|---|---|:---:|
| 249 E2E tests pass 100% | `npx tsx --test tests/e2e/**/*.test.ts` | PASS (249 passed, 0 failed, 1.70s) |
| 24 Tier 5 adversarial tests pass 100% | `npx tsx --test tests/tier5-backend-adversarial.test.ts` | PASS (24 passed, 0 failed, 0.79s) |
| Total repo tests: 570 passing | `npm test` | PASS (570 passed, 0 failed, 6.47s) |
| TypeScript compiles with zero errors | `npx tsc --noEmit` | PASS (exit code 0) |
| Worker dry-run build succeeds | `npm run build` | PASS (exit code 0, 121.10 KiB) |
| Local D1 migrations apply cleanly | `npx wrangler d1 migrations apply invoice-rescue-db --local` | PASS (exit code 0) |
| Zero runtime package dependencies | `package.json` inspection & build bundle check | PASS (100% native edge APIs) |
| Split-trust email routing enforced | Unit & integration tests on `email.ts` | PASS (NOTIFY locked, SEND locked) |

---

## 8. Conclusion & Recommendation

The work delivered for Milestone M5 satisfies all functional, architectural, and adversarial requirements specified in `ORIGINAL_REQUEST.md`, `PROJECT.md`, and `TEST_READY.md`. The test suite provides complete, uncompromising coverage across all features, boundaries, pairwise interactions, workload scenarios, and white-box adversarial vectors.

**Final Verdict**: **APPROVE**
