# E2E Test Infra: Invoice Rescue Credit-Control SaaS

## Test Philosophy
- Opaque-box, requirement-driven. Derives strictly from `ORIGINAL_REQUEST.md`.
- No dependency on internal module structure. Tests exercise system through HTTP requests, simulated webhooks, state machine transitions, and UI interaction surfaces.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.

## Feature Inventory & Test Matrix
| # | Feature | Source | Tier 1 (Coverage) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Real-World) |
|---|---------|--------|:-----------------:|:-----------------:|:-----------------:|:-------------------:|
| 1 | Multi-Tenant Data Isolation | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 2 | OAuth 2.0 Connection Lifecycle | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 3 | Token Encryption at Rest (AES-GCM) | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 4 | Webhook HMAC Verification | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 5 | Webhook Deduplication & Idempotency | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 6 | Accounting Ingestion & Sync | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 7 | Ingestion Daily Polling Cron | R1 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 8 | 4-Stage Escalation Cadence | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 9 | Terminal Escalation States | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 10 | BoE Base Rate + 8% Interest | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 11 | Statutory Compensation Tiers | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 12 | Locked Sender & Sign-off Model | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 13 | Chase Draft Generation & Staging | R2 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 14 | Executive Financial Dashboard | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 15 | Debtor Ledger Filtering & Search | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 16 | WCAG 2.2 AA Accessibility | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 17 | Review Queue Draft Editing | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 18 | Review Queue Approve & Defer | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 19 | Responsive & Theming Support | R3 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 20 | Edge Runtime Zero Runtime Deps | R4 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 21 | Split-Trust Email Routing | R4 / AC | 5 tests | 5 tests | ✓ | ✓ |
| 22 | D1 Migration & Schema Integrity | R4 / AC | 5 tests | 5 tests | ✓ | ✓ |

## Test Architecture
- **Test Runner**: Node.js test runner via `tsx --test tests/**/*.test.ts` or dedicated E2E runner `npm test`.
- **Pass/Fail Semantics**: All assertions must pass with exit code 0. Zero unhandled promise rejections or leaked exceptions.
- **Directory Layout**:
  - `tests/e2e/`: Opaque-box requirement tests organized by tier:
    - `tests/e2e/tier1-features.test.ts`: Happy path isolating each requirement.
    - `tests/e2e/tier2-boundaries.test.ts`: Corner cases, zero-drift interest, corrupt signatures, duplicate events, negative days overdue.
    - `tests/e2e/tier3-pairwise.test.ts`: Interactions (e.g., payment webhook arrives while draft is pending in review queue).
    - `tests/e2e/tier4-scenarios.test.ts`: Full lifecycle multi-tenant scenarios.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Multi-Tenant Agency Full Recovery Lifecycle | F1, F2, F6, F8, F10, F11, F12, F17, F18, F21 | High |
| 2 | Duplicate Webhook Ingestion During Draft Approval | F1, F4, F5, F9, F13, F18 | High |
| 3 | Leap Year & Multi-Year Debt Accumulation | F8, F10, F11, F14 | Medium |
| 4 | Token Rotation, Revocation & Re-Authentication | F2, F3, F6, F7 | Medium |
| 5 | Stage 4 Final Hand-Back with Debtor Settlement | F8, F9, F12, F14, F15, F18 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (22 features × 5 = 110 tests)
- Tier 2: ≥5 per feature (22 features × 5 = 110 tests)
- Tier 3: Pairwise combinations (≥22 tests)
- Tier 4: Real-world scenarios (≥5 comprehensive end-to-end scenarios)
