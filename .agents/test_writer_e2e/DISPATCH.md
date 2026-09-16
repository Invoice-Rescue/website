## 2026-09-16T05:12:11Z

<USER_REQUEST>
You are the E2E Test Suite Writer for the Credit-Control SaaS project.
Your working directory is: d:\Dev\Workspaces\Active\invoice-rescue\.agents\test_writer_e2e
Project root: d:\Dev\Workspaces\Active\invoice-rescue

Mandatory inputs to read:
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\ORIGINAL_REQUEST.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\PROJECT.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\orchestrator\TEST_INFRA.md
- d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules\report.md

Mission:
1. Design and write the comprehensive opaque-box E2E test suite in tests/e2e/ using Node test runner (compatible with `npm test` / `tsx --test`):
   - `tests/e2e/tier1-features.test.ts`: Feature coverage (>=5 test cases per feature across R1-R4 happy paths: tenant isolation, OAuth lifecycle, AES-GCM tokens, HMAC webhooks, deduplication, sync, 4-stage cadence, terminal states, statutory interest BoE+8%, statutory fees £40/£70/£100, locked sender Tibor Rames, review queue, split-trust routing).
   - `tests/e2e/tier2-boundaries.test.ts`: Boundary and corner cases (>=5 test cases per feature: zero-drift statutory interest, leap years, negative days overdue, boundary fees at £999.99 vs £1000 and £9,999.99 vs £10,000, empty/corrupt signatures, duplicate webhooks, replay attacks, cross-tenant leak attempts).
   - `tests/e2e/tier3-pairwise.test.ts`: Cross-feature combinatorial interactions (payment webhook arriving while draft in review queue, token revocation during sync, tenant switching, etc.).
   - `tests/e2e/tier4-scenarios.test.ts`: Real-world end-to-end workload scenarios (multi-tenant agency lifecycle, multi-debtor batch reconciliation, Stage 1 to Stage 4 hand-back).
2. Ensure tests compile with TypeScript (`npx tsc --noEmit`) and run with `npm test`.
3. When test suite is ready and verified, create `d:\Dev\Workspaces\Active\invoice-rescue\TEST_READY.md` documenting runner command and coverage breakdown.
4. Write your report to d:\Dev\Workspaces\Active\invoice-rescue\.agents\test_writer_e2e\report.md and a hard handoff to d:\Dev\Workspaces\Active\invoice-rescue\.agents\test_writer_e2e\handoff.md.
5. Send completion message to parent when done.

Rules:
- DO NOT modify production code in backend/src/ or frontend/. You are authorized only to write test files under tests/ and metadata in your agent directory, and publish TEST_READY.md at project root.
</USER_REQUEST>
