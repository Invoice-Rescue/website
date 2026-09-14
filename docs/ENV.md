# Environment Variables & Configuration Reference

This document provides a comprehensive reference of all environment variables, runtime configurations, and Cloudflare Worker secrets used by Invoice Rescue.

---

## 1. Configuration Overview

Invoice Rescue distinguishes between three classes of configuration:

1. **Production Secrets** (`wrangler secret put <SECRET_NAME>`): Encrypted secrets stored directly in Cloudflare's secrets vault. Never stored in git.
2. **Local Development Secrets** (`.dev.vars`): A local, git-ignored key-value file used by Wrangler during `npm run dev`.
3. **Environment Variables & Bindings** (`wrangler.jsonc` `vars`): Non-sensitive static configuration values bundled with the Worker deployment.

---

## 2. Environment Variables & Secrets Table

<!-- AUTO-GENERATED:ENV_START -->
The following environment variables and secrets are defined across [`.env.example`](file:///d:/Dev/Workspaces/Active/invoice-rescue/.env.example) and [`wrangler.jsonc`](file:///d:/Dev/Workspaces/Active/invoice-rescue/wrangler.jsonc):

| Variable / Secret | Type | Required | Default / Scope | Description | Example |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | Yes | Production & Local | API key for Google Gemini model used to draft debtor chase messages in client voice. | `AIzaSy...` |
| `ADMIN_SECRET` | Secret | Yes | Production & Local | Password for HTTP Basic Auth gating `/admin`, `/api/clients`, and invoice import/approval routes. | `openssl rand -hex 32` |
| `PORTAL_SESSION_SECRET` | Secret | Yes | Production & Local | 32-byte secret key used for HMAC-SHA256 signing of magic links and client session cookies. | `c68e74a8...` |
| `STRIPE_SECRET_KEY` | Secret | Yes | Production & Local | Stripe secret key (`sk_test_...` or `sk_live_...`) for creating customers and billing portal sessions. | `sk_test_51...` |
| `STRIPE_WEBHOOK_SECRET` | Secret | Yes | Production & Local | Stripe webhook endpoint signing secret (`whsec_...`) used to verify signatures at `/api/billing/webhook`. | `whsec_...` |
| `OPENROUTER_API_KEY` | Secret | No | Local / Fallback | Optional fallback API key for alternative LLM providers. | `sk-or-v1-...` |
| `CLOUDFLARE_API_TOKEN` | Secret | Yes | CI/CD & Deploy | Cloudflare API token with Workers Scripts Write and D1 edit permissions. | `cfat_...` |
| `NOTIFY_TO` | Var | Yes | `wrangler.jsonc` | Operator email address receiving new lead alerts, failed payment notices, and chase review digests. | `tiborcc2@gmail.com` |
| `NOTIFY_FROM` | Var | Yes | `wrangler.jsonc` | Sender email address for outgoing system notifications. Must be a verified domain. | `hello@invoicerescue.co.uk` |
| `INBOX_FORWARD_TO` | Var | Yes | `wrangler.jsonc` | Inbound email forwarding destination address for Cloudflare Email Routing. | `tibor@invoicerescue.co.uk` |
| `OPERATOR_NAME` | Var | Yes | `wrangler.jsonc` | Human operator display name recorded in `chase_log.reviewed_by` and surfaced in client audit trails. | `Tibor` |
| `BOE_BASE_RATE_PERCENT` | Var | Yes | `wrangler.jsonc` | Bank of England base interest rate percentage used to compute statutory interest (base + 8%). | `3.75` |
| `STRIPE_PUBLISHABLE_KEY` | Var | Yes | `wrangler.jsonc` | Stripe public key safe to expose in client-side landing and pricing pages. | `pk_test_51...` |
<!-- AUTO-GENERATED:ENV_END -->

---

## 3. Cloudflare Resource Bindings

Configured in [`wrangler.jsonc`](file:///d:/Dev/Workspaces/Active/invoice-rescue/wrangler.jsonc):

| Binding | Type | Resource / Target | Purpose |
| :--- | :--- | :--- | :--- |
| `DB` | `d1_databases` | `invoice-rescue-db` (`b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`) | Primary relational database for leads, clients, invoices, and chase logs. |
| `NOTIFY` | `send_email` | Destination restricted to `tiborcc2@gmail.com` | Safe outbound email channel for operator alerts and digests. |
| `SEND` | `send_email` | Unrestricted destinations | External email channel for sending debtor chase emails, client reports, and magic links. |
| `ASSETS` | `assets` | Directory `./frontend` | Serves landing pages, styles, scripts, robots.txt, and sitemap directly at the edge. |

---

## 4. Secret Provisioning & Management

### 4.1 Production Secrets Setup

Production secrets cannot be deployed via static API tokens; they require an interactive `wrangler login` session:

```bash
# Provision or rotate production secrets:
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put PORTAL_SESSION_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 4.2 Local Development Setup

For local testing, duplicate `.env.example` to `.dev.vars` in the workspace root:

```bash
cp .env.example .dev.vars
```

> [!CAUTION]
> `.dev.vars` is included in `.gitignore`. Under no circumstances should `.dev.vars` or any real credential files be committed to Git.
