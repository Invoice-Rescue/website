# BRIEFING — 2026-09-16T05:11:00Z

## Mission
Mine and specify the exact functional and mathematical specifications for R1 (Multi-Tenant Data Architecture & Accounting Synchronization) and R2 (Credit-Control Escalation & Statutory Calculation Engine).

## 🔒 My Identity
- Archetype: Specification Miner
- Roles: Statutory & Accounting Spec Miner
- Working directory: d:\Dev\Workspaces\Active\invoice-rescue\.agents\spec_miner_survey_rules
- Original parent: 98533014-b436-4060-87b0-afd5a79cff5a
- Milestone: M1 / R1 & R2 Survey & Specification

## 🔒 Key Constraints
- Multi-tenant data isolation constraints.
- Accounting synchronization: Xero and QuickBooks OAuth 2.0 lifecycle, AES-GCM (256-bit) Web Crypto token encryption at rest, cryptographic webhook HMAC signature verification for Xero and QuickBooks, event deduplication, idempotent invoice sync.
- Credit-Control Escalation state machine: 4 stages (Stage 1 Gentle: 1+ days overdue; Stage 2 Follow-up: 7+ days after Stage 1; Stage 3 Firm: 7+ days after Stage 2 with statutory notice; Stage 4 Final: 7+ days after Stage 3 with 7-day hand-back notice). Terminal states: paid, handed_back (no further chases).
- Statutory calculation engine: UK Late Payment of Commercial Debts (Interest) Act 1998:
  * Bank of England base rate + 8% per annum statutory interest calculated daily: (Principal * (BaseRate + 8) / 100) * (DaysOverdue / 365), zero rounding drift.
  * Statutory compensation fee tiers: £40 for debt < £1,000; £70 for debt £1,000 to £9,999.99; £100 for debt >= £10,000.
- Locked sender constraints: sender hello@invoicerescue.co.uk, signed by Tibor Rames on behalf of the client.
- Deliverability split-trust email routing (NOTIFY operator alerts vs SEND debtor emails).
- Read-only on source code: DO NOT modify or write source code files. Keep all metadata and reports within working directory.

## Current Parent
- Conversation ID: 98533014-b436-4060-87b0-afd5a79cff5a
- Updated: 2026-09-16T05:11:00Z

## Task Summary
- **What to build**: Full functional and mathematical specification for R1 & R2
- **Success criteria**: Exhaustive report.md with Features Discovered and Edge Cases tables, handoff.md, verified against codebase and authoritative specs
- **Interface contracts**: ORIGINAL_REQUEST.md, CLAUDE.md, invoice-rescue-build-plan.md, backend codebase
- **Code layout**: Read-only inspection of backend/, tests/, scripts/, docs/

## Key Decisions Made
- Fully specified and reconciled R1 & R2 against schema migrations 0001-0006, backend libraries, and authoritative UK statutes.
- Discovered and specified 21 concrete features across R1 & R2 categories.
- Documented 24 edge cases including zero rounding drift, composite unique invoice constraints, AES-GCM tamper rejection, and webhook HMAC signature verification.
- Verified test suite passes 100% (31/31 unit tests) and TypeScript type check passes with 0 errors.

## Artifact Index
- .agents/spec_miner_survey_rules/report.md — Comprehensive statutory and accounting specification
- .agents/spec_miner_survey_rules/handoff.md — 5-component hard handoff report
- .agents/spec_miner_survey_rules/DISPATCH.md — Task assignment log
- .agents/spec_miner_survey_rules/progress.md — Execution progress log
