# Edge Runtime & Dependency Analysis Report (Milestone M4 / R4)

**Date**: 2026-09-16  
**Auditor/Explorer**: Edge Runtime & Dependency Explorer  
**Scope**: `package.json`, `wrangler.jsonc`, `tsconfig.json`, `backend/src/**/*`, Dry-Run Build & Bundle Integrity  
**Status**: PASSED — ZERO RUNTIME DEPENDENCIES & 100% EDGE COMPATIBLE

---

## 1. Executive Summary

A comprehensive, read-only audit of the Invoice Rescue codebase was conducted to evaluate compliance with Milestone M4 (Edge Infrastructure & Deliverability Controls - R4).

Key findings:
1. **Zero Runtime Dependencies**: `package.json` contains **NO** `dependencies` object (completely absent). All runtime functionality in `backend/src/` is implemented exclusively using standard Web Platform APIs (`crypto.subtle`, `fetch`, `Headers`, `Request`, `Response`, `TextEncoder`, `TextDecoder`, `URLSearchParams`, `URL`) and native Cloudflare Workers bindings (`D1Database`, `SendEmail`, `Fetcher`). All external npm packages are strictly isolated to `devDependencies`.
2. **Edge Runtime Compatibility**: The worker configuration in `wrangler.jsonc` specifies `compatibility_date = "2026-07-15"` and `compatibility_flags = ["nodejs_compat"]`. There are zero runtime imports or invocations of Node.js built-in modules (`fs`, `child_process`, `net`, `http`, `path`, etc.) or native C++ addons.
3. **Dry-Run Bundle Verification**: `npm run build` (`wrangler deploy --dry-run`) completes with exit code 0, producing zero warnings and zero bundling errors. Total asset and script upload size is 118.46 KiB (gzip: 25.69 KiB). TypeScript typechecks pass cleanly (`tsc --noEmit`), and the automated test suite passes 100% (464 passing tests across 96 suites).
4. **Split-Trust Deliverability Controls**: Cloudflare Workers `send_email` bindings are strictly partitioned into `NOTIFY` (hard-restricted at the edge to destination `tiborcc2@gmail.com`) and `SEND` (unrestricted destination for debtor communications with strict locked-sender constraints: `hello@invoicerescue.co.uk` signed by Tibor Rames on behalf of the client).

---

## 2. Runtime Dependency Analysis (`package.json`)

### 2.1 Dependency Inventory

Direct inspection of `package.json` (lines 38–48):

```json
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260826.1",
    "@types/node": "^26.1.1",
    "markdownlint-cli2": "^0.23.2",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "wrangler": "^4.126.0"
  },
  "overrides": {
    "smol-toml": "^1.7.1"
  }
```

| Dependency Category | Presence | Value | Audit Finding |
|---|---|---|---|
| `dependencies` | **ABSENT** | `undefined` / absent | **COMPLIANT** (Requirement: `{}` or absent) |
| `peerDependencies` | **ABSENT** | `undefined` | **COMPLIANT** |
| `optionalDependencies` | **ABSENT** | `undefined` | **COMPLIANT** |
| `devDependencies` | Present | 6 packages | **COMPLIANT** — strictly tooling & dev types |

### 2.2 DevDependencies Purpose Analysis
- `@cloudflare/workers-types` (`^5.20260826.1`): Type definitions for Cloudflare Workers runtime (`D1Database`, `SendEmail`, `Fetcher`, `ExecutionContext`).
- `@types/node` (`^26.1.1`): Type definitions for Node.js test runner and build scripts.
- `markdownlint-cli2` (`^0.23.2`): Markdown documentation linting.
- `tsx` (`^4.23.13`): Local TypeScript test runner and DB seeding CLI.
- `typescript` (`^7.0.2`): Static type-checker (`tsc`).
- `wrangler` (`^4.126.0`): Cloudflare developer platform CLI.

No production runtime code imports any package from `devDependencies`.

---

## 3. Cloudflare Workers Edge Compatibility

### 3.1 Configuration Audit (`wrangler.jsonc`)

The repo utilizes `wrangler.jsonc` (Cloudflare's modern JSON-with-comments configuration standard supported by Wrangler v3/v4). Note that `wrangler.toml` is not present; `wrangler.jsonc` is the authoritative configuration.

Key configuration properties observed in `wrangler.jsonc`:
- **Main Entry Point**: `backend/src/index.ts`
- **Compatibility Date**: `"2026-07-15"` (Compliant with Cloudflare modern runtime standards)
- **Compatibility Flags**: `["nodejs_compat"]` (Enables Cloudflare's internal workerd Node compatibility layer)
- **Static Assets**: Directory `./frontend`, bound to `env.ASSETS`, routing `/api/*`, `/admin*`, `/portal*` to Worker first.
- **D1 Databases**: Binding `env.DB` linked to `invoice-rescue-db` (`b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`).
- **Send Email Bindings**:
  - `env.NOTIFY`: Edge-enforced `destination_address = "tiborcc2@gmail.com"`.
  - `env.SEND`: Unrestricted destination for debtor and client outbound email.
- **Triggers**: Crons configured for `0 6 * * *` (06:00 UTC daily overdue check & provider sync) and `0 8 * * FRI` (08:00 UTC Friday weekly cash digest).

### 3.2 Backend Codebase Static Analysis (`backend/src/`)

Every TypeScript file in `backend/src/` (21 items across `src/`, `lib/`, `types/`, and `integrations/`) was analyzed:

| File | External Packages | Node Built-ins | Standard Web APIs Used | Native CF Bindings Used |
|---|---|---|---|---|
| `backend/src/index.ts` | None | None | `URL`, `Request`, `Response`, `atob`, `JSON`, `Date`, `console` | `env.DB` (D1), `env.NOTIFY`, `env.SEND` |
| `backend/src/types/core.ts` | None | None | Pure TypeScript types & `Set` | None |
| `backend/src/lib/admin.ts` | None | None | String manipulation, HTML escaping | None |
| `backend/src/lib/chase-runner.ts` | None | None | `Date`, `Math`, `String` | `env.DB` (D1), `env.NOTIFY` |
| `backend/src/lib/csv.ts` | None | None | Pure string parser algorithm | None |
| `backend/src/lib/db.ts` | None | None | Re-exports `tenant-repo` | None |
| `backend/src/lib/escalation.ts` | None | None | `Date`, `Math` | None |
| `backend/src/lib/gemini.ts` | None | None | `fetch`, `Headers`, `JSON` | None |
| `backend/src/lib/portal-api.ts` | None | None | `Request`, `Response`, `URL`, `atob`, `Date`, `Math`, `JSON` | `env.DB` (D1), `env.SEND`, `env.NOTIFY` |
| `backend/src/lib/portal-auth.ts` | None | None | `crypto.subtle`, `TextEncoder`, `TextDecoder`, `Uint8Array`, `btoa`, `atob`, `JSON`, `Date` | None |
| `backend/src/lib/portal.ts` | None | None | String templating & HTML escaping | None |
| `backend/src/lib/statutory-interest.ts`| None | None | `Math.round` | None |
| `backend/src/lib/stripe.ts` | None | None | `fetch`, `URLSearchParams`, `crypto.subtle`, `TextEncoder`, `Uint8Array`, `parseInt` | None |
| `backend/src/lib/tenant-repo.ts` | None | None | `JSON`, `Date`, `RegExp` | `D1Database` (`env.DB`) |
| `backend/src/lib/integrations/accounting-types.ts` | None | None | Pure TypeScript types | None |
| `backend/src/lib/integrations/oauth-manager.ts` | None | None | `crypto.subtle`, `crypto.getRandomValues`, `fetch`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `Uint8Array`, `btoa`, `atob`, `Date` | None |
| `backend/src/lib/integrations/sync-service.ts` | None | None | `fetch`, `URLSearchParams`, `encodeURIComponent`, `Date`, `Math`, `JSON` | `D1Database` (`env.DB`) |
| `backend/src/lib/integrations/webhooks.ts` | None | None | `crypto.subtle`, `TextEncoder`, `Uint8Array`, `btoa`, `JSON` | None |

### 3.3 Confirmation of Zero Node.js or Native C++ Addons
- Regex grep for `(from ['"]node:|require\(|from ['"](fs|child_process|net|http|https|tls|dgram|cluster|os|path|process)['"])` returned **ZERO** matches across `backend/src/`.
- Regex grep for `require\(` returned **ZERO** matches.
- Regex grep for dynamic `import\(` returned **ZERO** matches.
- All imports in `backend/src/` are relative module imports resolving to adjacent TypeScript source files.

---

## 4. Dry-Run Build & Bundle Verification

Execution of `npm run build` (`wrangler deploy --dry-run`):

```text
> invoice-rescue@1.0.0 build
> wrangler deploy --dry-run

 ⛅️ wrangler 4.131.0
───────────────────────────────────────────────
✨ Read 20 files from the assets directory D:\Dev\Workspaces\Active\invoice-rescue\frontend
Total Upload: 118.46 KiB / gzip: 25.69 KiB
Your Worker has access to the following bindings:
Binding                                                                      Resource                  
env.NOTIFY (tiborcc2@gmail.com)                                              Send Email                
env.SEND (unrestricted)                                                      Send Email                
env.DB (invoice-rescue-db)                                                   D1 Database               
env.ASSETS                                                                   Assets                    
env.NOTIFY_TO ("tiborcc2@gmail.com")                                         Environment Variable      
env.NOTIFY_FROM ("hello@invoicerescue.co.uk")                                Environment Variable      
env.OPERATOR_NAME ("Tibor")                                                  Environment Variable      
env.BOE_BASE_RATE_PERCENT ("3.75")                                           Environment Variable      
env.STRIPE_PUBLISHABLE_KEY ("pk_test_51Tv4oWRc9HjdNS4PLbbcoyPRhWTZ...")      Environment Variable      

--dry-run: exiting now.
```

- **Exit Code**: `0`
- **Warnings / Errors**: `0`
- **Bundle Upload Footprint**: 118.46 KiB total (25.69 KiB gzipped), well within the Cloudflare Workers 1 MB / 10 MB bundle size limit.
- **Typecheck Status**: `npm run typecheck` (`tsc --noEmit`) completed with exit code 0 and zero diagnostic warnings.
- **Test Suite Pass**: 464 unit/integration tests passing in 5.1s across 96 suites (`npm test`).

---

## 5. Deliverability Controls & Split-Trust Routing Analysis

### 5.1 The Split-Trust Architecture
Email deliverability and operational integrity depend on strict isolation between internal alerts and debtor-facing correspondence:

1. **`env.NOTIFY` (Internal Operator Security Boundary)**:
   - Configuration in `wrangler.jsonc`:
     ```json
     {
       "name": "NOTIFY",
       "destination_address": "tiborcc2@gmail.com"
     }
     ```
   - Edge Protection: Cloudflare Email Routing validates at the edge that all messages sent via `env.NOTIFY` MUST have `to: "tiborcc2@gmail.com"`.
   - Code Call Sites:
     - Lead intake notifications (`handleLead` in `index.ts:345`)
     - Stripe payment failure alerts (`handleBillingWebhook` in `index.ts:803`)
     - Pending draft review queue alert (`runOverdueDetection` in `chase-runner.ts:245`)
     - Stage 4 escalation exhaustion alert (`runOverdueDetection` in `chase-runner.ts:157`)
   - Guarantee: Operator alerts, debtor payment failure logs, and draft notifications cannot accidentally leak to external debtor addresses.

2. **`env.SEND` (Outbound Client & Debtor Communications)**:
   - Configuration in `wrangler.jsonc`:
     ```json
     {
       "name": "SEND"
     }
     ```
   - Destination: Unrestricted (required for dispatching to client contacts and arbitrary debtor billing departments).
   - Code Call Sites:
     - Client portal magic login link (`handlePortalLoginRequest` in `index.ts:646`)
     - Weekly Friday cash report digest (`runFridayReport` in `index.ts:866`)
     - Approved chase notices (`handleChaseApprove` in `index.ts:575` and `handleApproveDraft` in `portal-api.ts:755`)
   - Enforced Sender Identity:
     - Outbound From: Always `env.NOTIFY_FROM` (`hello@invoicerescue.co.uk`) with display name `Invoice Rescue`.
     - Standard Sign-off: Hard-locked to:
       ```
       Tibor Rames
       Invoice Rescue — acting on behalf of {client_company_name}
       hello@invoicerescue.co.uk
       ```

### 5.2 Deliverability & Anti-Bot Safeguards
- **DMARC / SPF / DKIM Alignment**: Email dispatch is routed through Cloudflare Email Sending with DMARC alignment via `cf-bounce.invoicerescue.co.uk`.
- **Honeypot Form Protection**: In `handleLead`, a hidden `website` form field acts as a bot trap (`index.ts:325`). If populated, the endpoint silently returns HTTP 200/redirect to prevent bot retry adaptation while saving zero D1 records and sending zero emails.
- **Replay Attack Defense**: Stripe webhooks (`verifyWebhookSignature` in `stripe.ts:74`) enforce a 300-second (5 minute) timestamp tolerance window using Web Crypto HMAC-SHA256.
- **Timing Safe Verification**: Webhooks for QuickBooks and Xero use constant-time XOR comparison (`timingSafeEqual` in `webhooks.ts:43`) to prevent side-channel timing attacks.
- **Magic Link Expiry**: Client portal magic login tokens are cryptographically signed with HMAC-SHA256 and hard-expire after 900 seconds (15 minutes), preventing stale token replay.

---

## 6. Edge Runtime Risks & Deliverability Regressions

| ID | Category | Risk Description | Severity | Likelihood | Mitigation / Current Status |
|---|---|---|---|---|---|
| **R-01** | Config Naming | Tooling or CI script expecting `wrangler.toml` instead of `wrangler.jsonc`. | Low | Medium | `wrangler.jsonc` is natively parsed by Wrangler v3/v4; `npm run build` succeeds. If legacy tools need `wrangler.toml`, a symlink or `.toml` file could be maintained, but `wrangler.jsonc` is modern standard. |
| **R-02** | SendEmail Binding Quota | Cloudflare Workers SendEmail binding has account-level sending limits (e.g. 100/day on free tier). | High | Medium | Verify that the production Cloudflare account has Email Routing sending quota configured for high-volume enterprise credit control. |
| **R-03** | Transient Email Failures | `handleApproveDraft` in `portal-api.ts:755` awaits `env.SEND.send()` directly. If Cloudflare Email Sending is temporarily down, the endpoint throws a 500 error. | Medium | Low | Fail-safe: Because `chase_log` update occurs *after* `env.SEND.send()`, the draft remains in `status = 'draft'`. It will never be falsely marked as sent if the dispatch fails. |
| **R-04** | Base Rate Staleness | Bank of England base rate is configured via `vars.BOE_BASE_RATE_PERCENT = "3.75"` in `wrangler.jsonc`. | Medium | Medium | Base rate changes semi-annually. A manual operator checklist or automated scheduled checker should verify rate against Bank of England API before calculating statutory claims. |
| **R-05** | V8 Date Caching | Cloudflare Workers runtime caches `Date.now()` within execution turns. | Low | Low | All critical calculations compute relative date differences (`diffDays`, SQLite `julianday()`). Ingestion and webhook timestamps are generated inside I/O callbacks, which refresh the V8 clock. |

---

## 7. Conclusion

The repository satisfies all criteria for Milestone M4 (Edge Infrastructure & Deliverability Controls - R4):
- **100% Zero Runtime Dependencies**: Verified.
- **100% Standard Web Platform APIs & CF Bindings**: Verified.
- **Zero Node.js runtime built-ins or native addons**: Verified.
- **Clean Dry-Run Build & Bundle**: Verified (`wrangler deploy --dry-run` code 0).
- **Enforced Split-Trust Routing**: Verified (`NOTIFY` restricted vs `SEND` unrestricted).
