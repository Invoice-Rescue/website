# Invoice Rescue — Curated Reference Docs & Allowlist

This document maps all core technologies, APIs, and legal frameworks used in **Invoice Rescue** to their canonical, verified documentation sources.

Whenever you are implementing features, refactoring, or verifying behavior in this repository, follow the **reference-first rule**: check the authoritative vendor/spec source before coding rather than guessing.

---

## Pinned Stack Specifications

| Technology | Project Specification | Source of Truth |
| --- | --- | --- |
| **Cloudflare Workers Runtime** | `compatibility_date: "2026-07-15"`, flags: `["nodejs_compat"]` | [wrangler.jsonc](file:///d:/Dev/Workspaces/Active/invoice-rescue/wrangler.jsonc) |
| **Wrangler CLI** | `^4.126.0` | [package.json](file:///d:/Dev/Workspaces/Active/invoice-rescue/package.json) |
| **Workers Types** | `@cloudflare/workers-types: ^5.20260826.1` | [package.json](file:///d:/Dev/Workspaces/Active/invoice-rescue/package.json) |
| **TypeScript** | `^7.0.2` (Strict mode: `strict: true`) | [package.json](file:///d:/Dev/Workspaces/Active/invoice-rescue/package.json), [tsconfig.json](file:///d:/Dev/Workspaces/Active/invoice-rescue/tsconfig.json) |
| **Node.js Types** | `@types/node: ^26.1.1` | [package.json](file:///d:/Dev/Workspaces/Active/invoice-rescue/package.json) |
| **Database** | Cloudflare D1 (`invoice-rescue-db`) | [wrangler.jsonc](file:///d:/Dev/Workspaces/Active/invoice-rescue/wrangler.jsonc), [backend/db/](file:///d:/Dev/Workspaces/Active/invoice-rescue/backend/db/) |

---

## Canonical Documentation Mapping

| Area | Component in Repo | Authoritative Source | Verification URL |
| --- | --- | --- | --- |
| **Workers & Assets Routing** | `backend/src/index.ts`<br>`wrangler.jsonc` | Cloudflare Workers Docs | <https://developers.cloudflare.com/workers/> |
| **Wrangler CLI** | CLI commands (`dev`, `deploy`, `secret`) | Cloudflare Wrangler Docs | <https://developers.cloudflare.com/workers/wrangler/> |
| **D1 Database & Migrations** | `backend/db/migrations/`<br>`backend/src/index.ts` | Cloudflare D1 Docs | <https://developers.cloudflare.com/d1/> |
| **Email Sending** | `send_email` bindings (`NOTIFY`, `SEND`) | Cloudflare Email Service Docs | <https://developers.cloudflare.com/email-service/><br><https://developers.cloudflare.com/workers/runtime-apis/bindings/send-email/> |
| **Stripe REST API & Webhooks** | `backend/src/lib/stripe.ts` | Stripe Developer Docs | <https://docs.stripe.com/api><br><https://docs.stripe.com/webhooks> |
| **Gemini AI Drafting** | `backend/src/lib/gemini.ts` | Google AI Docs | <https://ai.google.dev/gemini-api/docs> |
| **Web Crypto API** | `backend/src/lib/portal-auth.ts`<br>`backend/src/lib/stripe.ts` | MDN Web Docs | <https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API> |
| **UK Statutory Interest** | `backend/src/lib/statutory-interest.ts` | UK Legislation.gov.uk | <https://www.legislation.gov.uk/ukpga/1998/20/contents> |
| **GitHub Actions & CI/CD** | `.github/workflows/` | GitHub Docs | <https://docs.github.com/en/actions> |
| **Antigravity & Agent Workflows** | `.agents/`, `.dev.vars`, skills, rules | Google Antigravity Docs | <https://antigravity.google/docs/> (mirror `.md`) |

---

## Reference-First Development Checklist

Before modifying or adding code in these critical areas:

1. **Cloudflare Bindings & Handlers**:
   - Check `wrangler.jsonc` and `worker-configuration.d.ts`.
   - Never add external npm dependencies when Cloudflare native bindings or Web standard APIs exist.
   - Run `npm run types` whenever bindings change.
2. **D1 Migrations**:
   - Never use ad-hoc manual SQL execution for schema changes.
   - Use `npx wrangler d1 migrations create invoice-rescue-db <name>`.
   - Test locally with `npx wrangler d1 migrations apply invoice-rescue-db --local`.
   - Use table reconstruction patterns when modifying SQLite constraints.
3. **Stripe Integration**:
   - Stripe is integrated via zero-dependency `fetch()` requests and Web Crypto HMAC-SHA256 signature verification.
   - Do not add `stripe-node` SDK to `package.json`.
   - Ensure webhook signature verification always fails closed if `STRIPE_WEBHOOK_SECRET` is unset.
4. **UK Late Payment Calculations**:
   - Formula must remain: `(Principal * (BoE_Base_Rate + 0.08) / 365) * Days_Overdue`.
   - Compensation tiers are legally fixed by statute: `<£1,000` = £40, `£1,000–£9,999.99` = £70, `£10,000+` = £100.
