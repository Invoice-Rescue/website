<!-- Generated: 2026-09-14 | Files scanned: 31 | Token estimate: ~650 -->
# Dependencies Codemap

## Zero External Runtime Dependencies

The production service has **0 external npm runtime dependencies**. All HTTP integrations (Google Gemini, Stripe API) are executed using edge-native `fetch()`, and cryptographic signatures (magic links, session cookies, Stripe webhook verification) are calculated via Web Standard `crypto.subtle`.

## Platform Bindings & Cloudflare Services

| Binding | Type | Resource / Configuration | Purpose |
| --- | --- | --- | --- |
| `env.DB` | D1 Database | `invoice-rescue-db` | Relational SQLite database for all system entities |
| `env.ASSETS` | Worker Assets | `frontend/` | Zero-configuration edge static asset serving |
| `env.NOTIFY` | Send Email | Operator Inbox (`tiborcc2@gmail.com`) | Restricted outbound email for internal system & lead alerts |
| `env.SEND` | Send Email | Public Outbound Delivery | Unrestricted outbound email for debtor chasing & magic links |

## External Third-Party APIs (via Native Fetch)

| Service | Target Endpoint | Authentication / Security | Integration Purpose |
| --- | --- | --- | --- |
| **Google Gemini** | `generativelanguage.googleapis.com` | `GEMINI_API_KEY` (secret) | Drafting contextual, polite escalation emails |
| **Stripe API** | `api.stripe.com/v1` | `STRIPE_SECRET_KEY` (secret) | Customer creation & hosted billing portal sessions |
| **Stripe Webhooks** | `/api/billing/webhook` | `STRIPE_WEBHOOK_SECRET` | HMAC-SHA256 signature verification for subscription sync |

## Developer & Build Tooling

Dependencies defined in [`package.json`](file:///D:/Dev/Workspaces/Active/invoice-rescue/package.json):

| Package | Version | Classification | Purpose |
| --- | --- | --- | --- |
| `typescript` | `^7.0.2` | devDependency | Typechecking and static verification (`npx tsc --noEmit`) |
| `wrangler` | `^4.126.0` | devDependency | Cloudflare Workers CLI, local dev, D1 migrations, bundle dry-run |
| `@cloudflare/workers-types` | `^5.20260826.1` | devDependency | Type definitions for Cloudflare Workers & D1 bindings |
| `tsx` | `^4.23.13` | devDependency | Native TypeScript test execution (`tsx --test`) & local seed script |
| `markdownlint-cli2` | `^0.23.2` | devDependency | Markdown linting and documentation standards enforcement |
| `@types/node` | `^26.1.1` | devDependency | TypeScript definitions for Node development utilities |
