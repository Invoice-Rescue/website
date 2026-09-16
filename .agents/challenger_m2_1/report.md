# Empirical Stress Test Report: Milestone M2 (Cadence & State Machine - R2)

**Challenger**: Challenger 1 (Milestone M2 - Cadence & State Machine Stress Testing)  
**Date**: 2026-09-16  
**Target Tested**: `backend/src/lib/chase-runner.ts`, `backend/src/lib/escalation.ts`, `backend/src/index.ts`  
**Test Suite Created**: `tests/challenger-m2-stress.test.ts` (21 tests, 7 test suites)  
**Overall Risk Assessment**: LOW  
**Verdict**: **APPROVE**

---

## 1. Challenge Summary & Executive Verdict

Milestone M2 implements the credit-control escalation engine, 4-stage statutory cadence, pending draft gating, and Stage 4 terminal hand-back for Invoice Rescue.

As Empirical Challenger 1, an adversarial stress test suite of 21 tests across 7 operational suites was written in `tests/challenger-m2-stress.test.ts` to independently verify the worker's implementation against all dispatch requirements and edge cases.

### Verdict: **APPROVE**
- **Late-Imported Invoices**: Invoices imported at 30 days and 60 days overdue strictly enforce a minimum 7-day spacing between stages. Stage 2 is NEVER staged before 7 full days have elapsed since Stage 1 was sent. Sub-day timestamps (e.g. 6 days 14 hours vs 7 days 1 hour) are conservatively respected.
- **Pending Draft Gating**: Repeated cron runs (tested up to 10 immediate iterations and 14 days later) generate zero duplicate drafts when an unreviewed draft (`status = 'draft'`) exists in `chase_log`. Fleet runs with mixed pending and non-pending invoices selectively gate only unreviewed invoices.
- **Terminal State Isolation**: Invoices marked `paid`, `escalated`, `disputed`, or `promised` are strictly excluded from automated chasing (`WHERE i.status = 'overdue'`). Mid-cycle payment transitions immediately halt future chase drafts.
- **Stage 4 Expiry & Terminal Transition**: 7-day grace period post-Stage 4 is rigorously maintained. At 7+ days post-Stage 4 send, invoice transitions to `escalated` and dispatches an operator alert via `env.NOTIFY` with client and debtor details. Subsequent runs remain completely silent.

---

## 2. Adversarial Challenge Dimensions & Empirical Results

### Challenge 1: Late-Imported Invoices (30d and 60d Overdue) Cadence & 7-Day Spacing
- **Assumption Challenged**: An invoice imported significantly past due (e.g. 30 days overdue) might evaluate static cadence thresholds (`days_overdue >= 8` for Stage 2, `>= 15` for Stage 3) and immediately rapid-fire follow-up chases on consecutive days.
- **Empirical Test 1.1**: Invoice imported at 30 days overdue. Stage 1 drafted and sent at T=0. Overdue detection executed on simulated Day 1 through Day 6 (1 to 6 days elapsed, 31 to 36 days overdue).
  - *Observed Result*: Exactly 0 drafts generated for Days 1 through 6 (`diffDays < 7`). On Day 7 (exactly 7 full days post-Stage 1), Stage 2 draft was created cleanly.
- **Empirical Test 1.2**: Invoice imported at 60 days overdue tested across all 4 stages.
  - *Observed Result*: Stage 1 generated at Day 0, Stage 2 deferred until Day 7, Stage 3 deferred until Day 14, Stage 4 deferred until Day 21. Exactly 7 days spacing between every stage.
- **Empirical Test 1.3**: Sub-day timestamp boundary precision. Stage 1 sent at 16:00 UTC. Morning cron at 06:00 UTC on Day 7 (6 days 14 hours elapsed) produced 0 drafts (`Math.floor(6.58) === 6`). Afternoon run at 17:00 UTC (7 days 1 hour elapsed) cleanly staged Stage 2.
- **Status**: **PASS (Robust)**

### Challenge 2: Pending Draft Gating (Duplicate Draft Prevention)
- **Assumption Challenged**: Multiple daily cron runs or delayed operator reviews could create redundant, conflicting drafts in `chase_log`, corrupting the review queue.
- **Empirical Test 2.1**: Invoice at 5 days overdue triggers Stage 1 draft. 10 rapid repeated cron invocations executed.
  - *Observed Result*: Run 1 created 1 draft (`skippedDrafts: 0`). Runs 2 through 10 created 0 drafts (`draftsCreated: 0`, `skippedDrafts: 1`). Final database row count in `chase_log` was exactly 1.
- **Empirical Test 2.2**: Multi-stage gating. Tested Stage 2, Stage 3, and Stage 4 unreviewed drafts left in `status = 'draft'` for 10 to 14 days.
  - *Observed Result*: In all cases, subsequent stages were blocked from generating until the pending draft was acted upon.
- **Empirical Test 2.3**: Fleet-level gating. 4 overdue invoices (2 with pending drafts, 2 without).
  - *Observed Result*: Cron selectively drafted only the 2 un-gated invoices, reporting `draftsCreated: 2, skippedDrafts: 2`.
- **Empirical Test 2.4**: Skipped draft handling. When operator skips a draft (`status = 'skipped'`, `reviewed_at` recorded), next step waits 7 days from `reviewed_at` before staging.
  - *Observed Result*: Successfully drafted next stage after 7-day spacing from review date.
- **Status**: **PASS (Robust)**

### Challenge 3: Terminal State Isolation & Non-Interference
- **Assumption Challenged**: Invoices in `paid` or `escalated` status, or non-overdue statuses (`disputed`, `promised`, future due date), might inadvertently be selected by the cron query.
- **Empirical Test 3.1 & 3.2**: Invoices with `status = 'paid'` (tested at 10d, 30d, 90d overdue) and `status = 'escalated'` (tested at 40d overdue).
  - *Observed Result*: 0 drafts created, 0 escalations, 0 operator notifications sent.
- **Empirical Test 3.3 & 3.4**: Invoices with `status = 'disputed'`, `status = 'promised'`, and future/current due dates (`date('now', '+1 day')`, `date('now')`).
  - *Observed Result*: 0 drafts created.
- **Empirical Test 6.2**: Mid-cycle payment. Debtor pays between Stage 2 and Stage 3.
  - *Observed Result*: Updating invoice to `status = 'paid'` immediately halts the chase sequence.
- **Status**: **PASS (Robust)**

### Challenge 4: Stage 4 Expiry & Terminal Hand-Back
- **Assumption Challenged**: Stage 4 final notice must give debtor 7 days to pay before escalating. Premature escalation or failure to notify the operator would violate credit control protocol.
- **Empirical Test 4.1**: Stage 4 sent at T=0. Cron executed on Days 0, 1, 2, 3, 4, 5, 6.
  - *Observed Result*: Days 0 through 6 remained in grace period: `invoicesEscalated: 0, draftsCreated: 0`, invoice status remained `overdue`, zero alerts sent.
  - *Day 7 Result*: `invoicesEscalated: 1`. Invoice status transitioned in SQLite to `escalated`. Operator alert delivered via `env.NOTIFY` with subject `Invoice Rescue: Invoice INV-APEX-5001 escalated (Stage 4 exhausted)` and body recommending legal hand-back.
  - *Days 8..15 Result*: Subsequent runs produced 0 escalations and zero duplicate alerts.
- **Empirical Test 4.2**: Un-sent Stage 4 draft (in review queue, not yet approved/sent).
  - *Observed Result*: After 10 days, invoice was NOT escalated because Stage 4 notice was never actually delivered to the debtor.
- **Empirical Test 4.3**: Batch expiry. 3 invoices reaching 7+ days post-Stage 4 concurrently.
  - *Observed Result*: All 3 transitioned to `escalated` in a single run, generating 3 individual operator notifications.
- **Status**: **PASS (Robust)**

### Challenge 5: Full 60-Day Multi-Week End-to-End Simulation
- **Empirical Test 6.1**: Full lifecycle trace of an invoice imported 35 days overdue, tracked daily across 45 simulated days.
  - Day 0 (T=0): Stage 1 drafted -> approved & sent.
  - Days 1..6: 0 drafts created.
  - Day 7: Stage 2 drafted -> approved & sent.
  - Days 8..13: 0 drafts created.
  - Day 14: Stage 3 drafted -> approved & sent.
  - Days 15..20: 0 drafts created.
  - Day 21: Stage 4 drafted -> approved & sent.
  - Days 22..28: 7-day grace period; status stays `overdue`, 0 drafts created.
  - Day 29 (7d post Stage 4): Transitions to `escalated`, operator alert sent.
  - Days 30..45: Completely silent.
- **Status**: **PASS (Robust)**

---

## 3. Empirical Test Outputs

### Full Test Suite Run (`npm test`)
```
▶ tests/challenger-m2-stress.test.ts
  ▶ Empirical Challenger M2: Cadence & State Machine Stress Testing
    ▶ 1. Late-Imported Invoices & Spacing Enforcement
      ✔ 1.1: Invoice imported 30 days overdue does NOT trigger Stage 2 until 7+ days after Stage 1 sent (44.3284ms)
      ✔ 1.2: Invoice imported 60 days overdue respects 7-day pacing across all 4 stages (10.1344ms)
      ✔ 1.3: Sub-day timestamp boundary precision enforces full 24-hour day spacing (6.493ms)
    ✔ 1. Late-Imported Invoices & Spacing Enforcement (62.1204ms)
    ▶ 2. Pending Draft Gating & Deduplication
      ✔ 2.1: Repeated cron runs on same day produce zero duplicates when status = 'draft' (12.1522ms)
      ✔ 2.2: Pending draft gating protects all stages (Stage 2, Stage 3, Stage 4) from duplicate staging (10.1548ms)
      ✔ 2.3: Fleet-level gating with mixed pending and non-pending invoices (9.7401ms)
      ✔ 2.4: Skipped draft allows next step to proceed after 7-day spacing from review (9.8631ms)
    ✔ 2. Pending Draft Gating & Deduplication (42.4864ms)
    ▶ 3. Terminal State Transitions & Non-Interference
      ✔ 3.1: Invoices in 'paid' status are NEVER chased regardless of overdue days (7.1241ms)
      ✔ 3.2: Invoices in 'escalated' status are NEVER chased and trigger no further alerts (5.5617ms)
      ✔ 3.3: Invoices in 'disputed' or 'promised' status are not chased by cron (5.1574ms)
      ✔ 3.4: Future due dates (not yet overdue) are never chased (5.2717ms)
    ✔ 3. Terminal State Transitions & Non-Interference (23.5399ms)
    ▶ 4. Stage 4 Expiry & Terminal Hand-Back
      ✔ 4.1: Progression from Stage 4 sent -> day 6 grace -> day 7 escalation -> subsequent silence (7.4601ms)
      ✔ 4.2: Un-sent Stage 4 draft does NOT trigger escalation after 7+ days (5.972ms)
      ✔ 4.3: Multiple invoices expiring Stage 4 concurrently escalate cleanly (6.237ms)
    ✔ 4. Stage 4 Expiry & Terminal Hand-Back (19.9618ms)
    ▶ 5. Boundary & Calculation Engine Adversarial Verification
      ✔ 5.1: advanceEscalationStage pure function validates 7-day pacing and handback decision (0.6202ms)
      ✔ 5.2: Statutory interest and compensation calculations match 1998 Act precisely (0.3233ms)
      ✔ 5.3: Fallback template incorporates genuine client name and statutory figures (2.7581ms)
    ✔ 5. Boundary & Calculation Engine Adversarial Verification (3.9079ms)
    ▶ 6. Full Multi-Week Adversarial Simulation
      ✔ 6.1: Complete 60-day lifecycle of a late-imported invoice (imported 35d overdue) (12.0188ms)
      ✔ 6.2: Mid-escalation payment transition immediately halts chase sequence (4.9539ms)
    ✔ 6. Full Multi-Week Adversarial Simulation (17.1102ms)
    ▶ 7. Leap Year & Date Arithmetic Boundary Robustness
      ✔ 7.1: Leap year February 29 date transitions calculate accurate day spacing (5.7464ms)
      ✔ 7.2: diffDays utility correctly handles negative differences and identical timestamps (0.2349ms)
    ✔ 7. Leap Year & Date Arithmetic Boundary Robustness (6.1065ms)
  ✔ Empirical Challenger M2: Cadence & State Machine Stress Testing (176.4211ms)

ℹ tests 382
ℹ suites 78
ℹ pass 382
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3482.7208
```

---

## 4. Verification Gates Summary

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| TypeScript Typecheck | `npx tsc --noEmit` | Exit code 0, 0 errors | PASS |
| Unit & Integration Tests | `npm test` | 382 passing tests across 78 suites, 0 failures | PASS |
| Challenger M2 Stress Suite | `npx tsx --test tests/challenger-m2-stress.test.ts` | 21 passing tests across 7 suites, 0 failures | PASS |
| Worker Dry-Run Bundle | `npm run build` (`wrangler deploy --dry-run`) | Exit code 0, clean bundle (94.86 KiB) | PASS |
| Local D1 Migrations | `npx wrangler d1 migrations apply invoice-rescue-db --local` | "No migrations to apply!", 0 schema drift | PASS |

---

## 5. Final Verdict

**VERDICT: APPROVE**

The implementation of Milestone M2 satisfies all requirements of the Credit-Control Escalation & Statutory Calculation Engine. The cadence state machine behaves deterministically and correctly under adversarial stress, edge conditions, and real-world multi-week workloads.
