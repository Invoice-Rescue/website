---
name: cloudflare-worker-hardening
description: |
  Fixes an under-scoped Cloudflare API deploy token and sets up Cloudflare
  Access to protect unauthenticated routes on the invoice-rescue Worker. Use
  when `wrangler deploy` or `wrangler secret put` fail with `Authentication
  error [code: 10000]`, when scoping a new Cloudflare API token for this
  project's CI/CD, or when adding auth in front of /admin, /api/chase/*, or
  /api/clients* before real client/debtor data flows through them (see this
  repo's CLAUDE.md "Known gaps").
---

# Cloudflare Worker Hardening (invoice-rescue)

Two independent gaps, fix either or both:

1. The local deploy token can list D1 databases but can't touch Workers
   Scripts — `wrangler deploy` and `wrangler secret put` both fail.
2. `/admin`, `/api/chase/*`, and `/api/clients*` have zero auth in the Worker
   itself (see `backend/src/index.ts` header comment).

## 1. Fix the deploy token

**Root cause:** the token has D1 read/list access but is missing the Workers
Scripts permission entirely — not a wrong scope, a missing one.

**Minimum permission set** (Account-level, all under `com.cloudflare.api.account`):

| Permission | Why |
|---|---|
| `Workers Scripts:Edit` | Required for both `wrangler deploy` and `wrangler secret put` — this is almost certainly the missing one |
| `D1:Edit` | Already works read-side per the known-gap note; Edit covers migrations too |
| `Account Settings:Read` | `wrangler` reads this at startup to resolve the account |

If deploy still fails after adding these three, the token may also need
**`Workers Routes:Edit`** — but that's a **Zone**-level permission (scoped to
the `invoicerescue.co.uk` zone specifically, not Account), and this project
uses `custom_domain: true` routes in `wrangler.jsonc` rather than the older
zone-route pattern, so it may not apply here. Add it only if the error
message after the fix above still references routes/zones.

**Steps:**

1. Dashboard → **My Profile → API Tokens** (personal) or **Manage Account →
   API Tokens** (account-owned) → find the existing token → **Edit** (or
   create a new one via **Create Token → Create Custom Token** if starting
   fresh).
2. Add the three Account permissions above. Leave existing D1 permissions as
   they are — this is additive, not a rebuild.
3. Save, then verify **before** retrying deploy:
   ```bash
   curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
     --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
   ```
   A `"status": "active"` response confirms the token itself is valid — it
   does not confirm the new permissions are enough, only that the token
   works at all. The real test is the next step.
4. Retry: `npx wrangler deploy` (and `npx wrangler secret put GEMINI_API_KEY` /
   `STRIPE_SECRET_KEY` once deploy succeeds).

**Alternative for local human use:** skip API tokens entirely with
`wrangler login` — opens a browser OAuth consent screen, no manual dashboard
token editing, no risk of forgetting a permission. Keep the API token
approach only for headless/CI contexts (`CLOUDFLARE_API_TOKEN` env var).
Verify whichever method with `wrangler whoami`.

**Once deploy succeeds:** diff the deployed bundle against `backend/src/index.ts`
before assuming they match — CLAUDE.md flags that production has been running
stale code (missing `POST /api/clients` at minimum) for a while.

## 2. Add Cloudflare Access in front of the unauthenticated routes

**Why Access and not Worker-level middleware:** Access sits at the Cloudflare
edge, in front of both the static asset server and the Worker. A hand-rolled
auth check inside `backend/src/index.ts` only protects requests that actually
reach the Worker — if a future change ever adds a static file that shadows
one of these paths (e.g. a static `frontend/admin.html`), Worker-level auth
would silently stop applying to it while Access would not. Edge-level is the
safer default here regardless.

**Exact paths to protect** (from `backend/src/index.ts`'s route list — note
the trailing wildcards, both routes have sub-paths beyond the literal prefix
CLAUDE.md names):

| Path pattern | Covers |
|---|---|
| `invoicerescue.co.uk/admin` | `GET /admin` (chase-draft review queue) |
| `invoicerescue.co.uk/api/chase/*` | `POST /api/chase/:id/approve`, `POST /api/chase/:id/skip` |
| `invoicerescue.co.uk/api/clients*` | `POST /api/clients` **and** `POST /api/clients/:id/invoices/import` — the bare `/api/clients` pattern from CLAUDE.md misses the import sub-route; the trailing `*` (no slash before it) is required to catch both |

**Steps:**

1. Dashboard → **Zero Trust → Access controls → Applications → Create new
   application → Self-hosted and private → Add public hostname**.
2. Domain: `invoicerescue.co.uk` (already an active zone in this account —
   confirmed via `wrangler.jsonc`'s `routes` block). Do this as **three
   separate applications**, one per path pattern above — Access applications
   are one path pattern each, not a multi-path list.
3. For each: **Access policies → Add a policy** → Action `Allow` → Include
   rule: **Emails** → `tiborcc2@gmail.com` (the operator address this project
   already uses elsewhere — see `wrangler.jsonc`'s `NOTIFY_TO`/`send_email`
   config). Everything not matching an Allow policy is denied by default.
4. Authentication: default identity provider is fine for a single-operator
   setup (One-time PIN via email is enabled by default, no extra IdP
   configuration needed for one person).
5. Leave **Additional Settings** (App Launcher, block page, CORS, cookies) at
   defaults unless something specific comes up later.

**Path syntax gotchas** (get these wrong and the policy silently doesn't
match what you expect):
- No query strings and no port numbers in the Path field — Access strips
  them before matching.
- At most one wildcard between each pair of slashes (`/api/chase/*` is fine;
  `/api/ch*se/*` with two wildcards in one segment is not).
- More specific paths override less specific ones automatically — if a
  narrower policy is ever added under `/admin/exec` later, it takes
  precedence over the `/admin` policy for that sub-path, no manual ordering
  needed.

## Verification checklist

Maps directly to this repo's `CLAUDE.md` "Known gaps" section — both done
means that section can be deleted:

- [ ] `npx wrangler deploy` succeeds (no `Authentication error [code: 10000]`)
- [ ] `npx wrangler secret put GEMINI_API_KEY` and `STRIPE_SECRET_KEY` succeed
- [ ] Deployed bundle diffed against `backend/src/index.ts` — confirm they
      now match, since prod was running stale code before the token was fixed
- [ ] Visiting `https://invoicerescue.co.uk/admin` while logged out prompts
      for Access authentication instead of showing the review queue directly
- [ ] Same for `/api/chase/<any-id>/approve` and `/api/clients` — a plain
      unauthenticated `curl` to either now gets an Access login redirect, not
      a 200 or the Worker's own response
