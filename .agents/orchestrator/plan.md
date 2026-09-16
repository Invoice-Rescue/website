# Plan: B2B Credit-Control SaaS Implementation & Verification

## Objective
Deliver an end-to-end, multi-tenant B2B credit-control SaaS on Cloudflare (Workers, D1, Pages) satisfying all requirements (R1-R4) and passing the quality gates:
1. `npx tsc --noEmit` passes with 0 errors
2. `npm test` passes 100%
3. `npm run build` bundles cleanly
4. `npx wrangler d1 migrations apply invoice-rescue-db --local` succeeds

## Phases

### Phase 0: Survey & Scope Mapping (Parallel Explorers)
- Dispatch 3 Explorers / Spec Miners:
  1. `explorer_survey_backend`: Investigate existing backend, Cloudflare worker structure, D1 database schema/migrations, auth, and API routes.
  2. `explorer_survey_escalation_accounting`: Investigate accounting integrations (Xero, QuickBooks OAuth/webhooks), statutory calculation engine requirements, BoE base rate + 8%, late fee tiers, locked sender model.
  3. `explorer_survey_frontend_testing`: Investigate frontend portal structure (dashboard, debtor ledger, draft review queue, dark/light, WCAG 2.2 AA), existing test setup, build configuration, and dependencies.
- Aggregate findings into a unified Feature Inventory and Architecture baseline.

### Phase 1: Decomposition & Global Index (PROJECT.md)
- Define interface contracts between:
  - Multi-tenant D1 schema & OAuth/webhook layer
  - Escalation state machine & statutory interest calculation engine
  - Worker REST API & Client Portal (Dashboard / Ledger / Draft Review)
  - Worker edge deliverability & split-trust email routing
- Finalize milestones M1..M4 + Final Milestone M5.

### Phase 2: Dual-Track Dispatch
- Track A: E2E Testing Orchestrator
  - Decompose opaque-box requirement tests:
    - Tier 1: Feature Coverage (>=5 per feature)
    - Tier 2: Boundary & Corner Cases (>=5 per feature)
    - Tier 3: Cross-Feature Combinations (pairwise)
    - Tier 4: Real-World Workload Scenarios
  - Produce TEST_READY.md
- Track B: Implementation Track (Milestones M1 - M4)
  - M1: Multi-Tenant Data Architecture & Accounting Synchronization (D1 migrations, tenant isolation, AES-GCM token encryption, Xero/QBO webhooks & idempotent sync)
  - M2: Credit-Control Escalation & Statutory Calculation Engine (4-stage escalation state machine, statutory interest BoE+8%, statutory fees £40/£70/£100, locked sender Tibor Rames)
  - M3: Client Portal & Human-in-the-Loop Review Queue (Executive dashboard, debtor ledger with debounced search/filtering WCAG 2.2 AA, draft approval queue with in-place edits and send/defer)
  - M4: Edge Infrastructure & Deliverability Controls (Zero runtime external deps on Worker, split-trust NOTIFY vs SEND, deliverability headers/mechanisms)

### Phase 3: Final Milestone M5 (E2E Test Pass & Adversarial Hardening)
- Phase 1: 100% pass of Tiers 1-4 tests
- Phase 2: Tier 5 adversarial hardening with Challenger -> Worker -> Reviewer loop

### Phase 4: Final Verification Gate & Completion Report
- Verify all 4 quality gates pass:
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
  - `npx wrangler d1 migrations apply invoice-rescue-db --local`
- Independent Forensic Audit: Clean verdict.
- Report completion back to parent with full verification details.
