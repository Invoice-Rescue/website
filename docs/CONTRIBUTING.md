# Contributing to Invoice Rescue

Thank you for contributing to Invoice Rescue. This document outlines the development workflow, prerequisites, testing practices, code quality guidelines, and pull request procedures.

---

## 1. Prerequisites

Before getting started, ensure you have the following installed on your machine:

- **Node.js**: `v22.x` (Active LTS) or newer. Check with `node --version`.
- **npm**: `v10.x` or newer. Check with `npm --version`.
- **Cloudflare Wrangler CLI**: Installed locally via project `devDependencies`.
- **Git**: For version control.

---

## 2. Development Environment Setup

### 2.1 Clone and Install

```bash
git clone https://github.com/Invoice-Rescue/website.git
cd website
npm ci
```

### 2.2 Configure Local Secrets & Environment Variables

Copy the example environment file to `.dev.vars` (which is git-ignored and used by Wrangler locally):

```bash
cp .env.example .dev.vars
```

Populate the required development secrets in `.dev.vars`:

- `GEMINI_API_KEY`: API key for Gemini chase message drafting.
- `ADMIN_SECRET`: Password used for HTTP Basic Auth on `/admin` and management endpoints.
- `PORTAL_SESSION_SECRET`: 32-byte hex string (generate with `openssl rand -hex 32`).
- `STRIPE_SECRET_KEY`: Stripe test-mode secret key (`sk_test_...`).
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook signing secret (`whsec_...`).

> [!WARNING]
> Never commit `.dev.vars`, API keys, or database credentials to version control. See [docs/ENV.md](file:///d:/Dev/Workspaces/Active/invoice-rescue/docs/ENV.md) for full variable descriptions and security standards.

### 2.3 Initialize Local D1 Database

Invoice Rescue uses Cloudflare D1 for database storage. Apply the database migrations locally:

```bash
npx wrangler d1 migrations apply invoice-rescue-db --local
```

Seed the local database with sample clients, invoices, and draft chase records:

```bash
npm run db:seed
```

### 2.4 Start the Local Development Server

Start the Cloudflare Worker and asset server locally:

```bash
npm run dev
```

The application will be accessible at:

- **Frontend / Landing Page**: `http://127.0.0.1:8787/`
- **Client Portal Login**: `http://127.0.0.1:8787/portal`
- **Operator Admin Review Queue**: `http://127.0.0.1:8787/admin`
- **Health Check**: `http://127.0.0.1:8787/api/health`

---

## 3. Available Scripts Reference

<!-- AUTO-GENERATED:SCRIPTS_START -->
The following npm scripts are defined in [`package.json`](file:///d:/Dev/Workspaces/Active/invoice-rescue/package.json):

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start local Cloudflare Worker development server with asset binding and local D1 (`wrangler dev`). |
| `npm run build` | Validate Cloudflare Worker bundle without deploying (`wrangler deploy --dry-run`). |
| `npm run typecheck` | Run static type checking across all TypeScript source and test files (`tsc --noEmit`). |
| `npm run types` | Regenerate TypeScript binding types in `worker-configuration.d.ts` from `wrangler.jsonc`. |
| `npm test` | Run automated unit test suite using Node.js test runner via `tsx` (`tests/**/*.test.ts`). |
| `npm run verify` | Complete pre-commit quality gate: runs markdown linting, TypeScript typecheck, unit tests, and bundle dry-run. |
| `npm run lint` | Run documentation markdown linting and TypeScript type checking. |
| `npm run lint:md` | Lint markdown files across the repository using `markdownlint-cli2`. |
| `npm run lint:md:fix` | Automatically fix formatting issues in markdown documentation. |
| `npm run db:seed` | Seed local D1 database with sample clients, overdue invoices, and draft chase logs. |
| `npm run deploy` | Bundle and deploy Worker and static assets to Cloudflare (`wrangler deploy`). |
| `npm run deps:check` | Check for outdated npm dependencies (`npm outdated`). |
| `npm run deps:update` | Update npm dependencies and immediately verify types and build. |
| `npm run deps:audit` | Run npm security vulnerability audit. |
| `npm run git:repair` | Run repository PowerShell script to rebuild and repair corrupted Git index state. |
<!-- AUTO-GENERATED:SCRIPTS_END -->

---

## 4. Testing Procedures

### 4.1 Running Automated Unit Tests

Run the test suite:

```bash
npm test
```

Automated unit tests are located in `tests/` and cover:

- **Statutory Interest** ([`tests/statutory-interest.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/statutory-interest.test.ts)): Late Payment of Commercial Debts Act calculations and compensation bands.
- **CSV Ingestion** ([`tests/csv.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/csv.test.ts)): Ingestion of invoice CSV files, handling quotes, commas, and line endings.
- **Escalation Cadence** ([`tests/escalation.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/escalation.test.ts)): Days overdue thresholds and chase step progression.
- **Portal Authentication** ([`tests/portal-auth.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/portal-auth.test.ts)): Web Crypto HMAC-SHA256 magic-link and session cookie generation and verification.
- **Stripe Webhooks** ([`tests/stripe.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/stripe.test.ts)): Signature verification, timestamp validation, and replay attack defense.
- **Gemini Prompts** ([`tests/gemini.test.ts`](file:///d:/Dev/Workspaces/Active/invoice-rescue/tests/gemini.test.ts)): Prompt synthesis for reminder vs formal statutory escalation notices.

### 4.2 Writing New Tests

- Place test files alongside related tests in `tests/<feature>.test.ts`.
- Use Node.js built-in `node:test` and `node:assert/strict` modules.
- Ensure tests are deterministic and do not depend on active network or external API availability.

### 4.3 Integration Smoke Testing

Test against a running local dev server:

```bash
BASE_URL=http://127.0.0.1:8787 ADMIN_SECRET=local-dev-secret STRIPE_WEBHOOK_SECRET=... backend/test/rest-api.sh
```

### 4.4 Manual Cron Trigger Testing

Simulate Cloudflare cron triggers locally:

```bash
# Trigger daily 06:00 UTC overdue detection & AI drafting:
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"

# Trigger Friday 08:00 UTC weekly cash report:
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+8+*+*+FRI"
```

---

## 5. Code Style & Engineering Standards

All contributions must follow the repository's clean-code non-negotiables:

1. **Zero Secrets in Code**: Credentials, tokens, and keys must stay in `.dev.vars` locally and Cloudflare Secrets in production. Never commit credentials to version control.
2. **Strict Typing**: Strict TypeScript mode is enabled (`tsconfig.json`). Never use `any` unless strictly necessary; use `unknown` and discriminate with type guards.
3. **Parameterized SQL**: All Cloudflare D1 interactions must use parameterized queries (`env.DB.prepare("...").bind(...)`). String concatenation in SQL statements is strictly prohibited.
4. **Boundary Validation**: Validate and sanitize all external user input, form submissions, query parameters, and webhook payloads at the edge before passing to domain logic.
5. **Resilient Error Handling**: Never silently swallow exceptions. Catch errors where actionable, provide diagnostic context in logs, and return clean user-facing error responses without leaking stack traces.
6. **Statutory Integrity**: Debtor communications and interest calculations must strictly adhere to the UK Late Payment of Commercial Debts (Interest) Act 1998.

---

## 6. Pull Request Submission Checklist

Before submitting a pull request, verify that:

- [ ] `npm run verify` passes completely (`lint:md`, `typecheck`, `test`, `build`).
- [ ] No temporary files, credentials, or `.dev.vars` modifications are committed.
- [ ] Any new endpoints or environment variables are documented in [`docs/API.md`](file:///d:/Dev/Workspaces/Active/invoice-rescue/docs/API.md) and [`docs/ENV.md`](file:///d:/Dev/Workspaces/Active/invoice-rescue/docs/ENV.md).
- [ ] New database migrations are added to `backend/db/migrations/` and tested locally.
- [ ] PR description follows [`.github/pull_request_template.md`](file:///d:/Dev/Workspaces/Active/invoice-rescue/.github/pull_request_template.md).
