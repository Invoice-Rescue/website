# ADR 0001: Cloudflare Workers + D1 Architecture & Zero External Runtime Dependencies

## Status

Accepted (2026-07-16)

## Context

Invoice Rescue provides automated, AI-assisted credit control for UK service businesses. The service requires:

1. Fast, low-latency landing page and marketing site.
2. Lightweight REST API for lead capture, client onboarding, CSV invoice imports, and administrative review.
3. Daily and weekly scheduled background tasks (crons) for detecting overdue invoices, drafting chase emails with Gemini, and emailing cash summaries.
4. Client portal with passwordless magic-link login and Stripe self-serve billing.
5. Low maintenance and minimal hosting costs for a solo operator servicing 2-30 clients.

## Decision

We chose a single unified Cloudflare Worker deployment with:

1. **Static Assets Binding (`ASSETS`)**: Serves the `frontend/` directory directly with 0ms cold starts without invoking the Worker.
2. **Cloudflare D1 Database (`DB`)**: Serverless SQLite database managed via numbered migrations (`backend/db/migrations/*.sql`) using `wrangler d1 migrations`.
3. **Cloudflare Email Service (`NOTIFY` & `SEND`)**: Split trust-level bindings for operator notifications vs debtor/client communications.
4. **Zero External Runtime Dependencies**: Standard Web Platform APIs (Fetch, Web Crypto, URLSearchParams) used directly. Stripe is integrated via plain `fetch()` calls rather than the heavyweight `stripe-node` SDK.
5. **HMAC Web Crypto Authentication**: Portal sessions and magic links use HMAC-SHA256 tokens signed via Web Crypto without external JWT packages.
6. **Built-in TypeScript & Test Runner**: TypeScript strict typechecking (`tsc --noEmit`), unit tests via `tsx --test` with Node standard assertions, and static Markdown linting.

## Consequences

### Positive

- One command deployment (`wrangler deploy`) bundles and deploys frontend and backend simultaneously.
- Zero server maintenance, zero container overhead, zero database connection pool limits.
- Extremely small bundle size (<40KB) and instant startup times.
- Resilient offline testing and local dev via `wrangler dev` and local D1 SQLite.

### Negative / Trade-offs

- Cloudflare Workers runtime environment differs slightly from Node.js (uses V8 workerd). Node-specific packages or C++ native addons cannot be used.
- Schema rollbacks require explicit forward migrations as SQLite does not support `DROP CONSTRAINT`.
