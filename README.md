# Invoice Rescue

AI-assisted credit-control service for UK service businesses — every overdue invoice
chased in the client's name, escalating and professional, until it's paid.
12%-success-fee model retired; current pricing is subscription tiers (see
[docs/business-plan.html](docs/business-plan.html)): Foundation £349/mo, Engine
£649/mo, Operator £1,250/mo.

**Live at:** [invoicerescue.co.uk](https://invoicerescue.co.uk)

Runs entirely on Cloudflare's free tier: one Worker, one D1 database, zero
external dependencies, zero monthly cost.

## Project structure

```text
invoice-rescue/
├── frontend/              Static landing page — served directly by Cloudflare
│   ├── index.html          as static assets, no Worker code runs for "/"
│   ├── robots.txt
│   └── sitemap.xml
├── backend/                Cloudflare Worker — API only
│   ├── src/
│   │   ├── index.ts          Router + cron handlers (see routes below)
│   │   └── lib/               csv.ts, statutory-interest.ts, escalation.ts,
│   │                          gemini.ts, admin.ts
│   ├── db/
│   │   └── migrations/        D1 schema, tracked via `wrangler d1 migrations`
│   │       ├── 0001_initial_schema.sql
│   │       ├── 0002_credit_control.sql
│   │       └── 0003_add_check_constraints.sql
│   └── test/
│       └── rest-api.sh       curl-based smoke test
├── docs/
│   ├── business-plan.html         The 1-Person AI Powered Business Plan
│   └── credit-control-system-design.md   Design for the AI chasing engine —
│                                          CSV/cron/draft/review/send/report
│                                          built; Xero/QuickBooks OAuth sync
│                                          still deliberately not built
├── .agent/AGENTS.md         Local agent skill config
├── wrangler.jsonc           Deploy config — main + assets in one Worker
├── tsconfig.json            Type-checking only (wrangler doesn't need it to build)
└── .gitignore
```

**Routes:**

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| POST | `/api/lead` | Landing-page free-audit form |
| POST | `/api/clients` | Onboard a new client — **requires admin auth, see below** |
| POST | `/api/clients/:id/invoices/import` | CSV invoice import — **requires admin auth** |
| GET | `/admin` | Chase-draft review queue — **requires admin auth** |
| POST | `/api/chase/:id/approve` | Send an approved chase message — **requires admin auth** |
| POST | `/api/chase/:id/skip` | Skip a draft — **requires admin auth** |

Cron Triggers: `0 6 * * *` (detect-overdue, drafts next chase step via Gemini) and
`0 8 * * FRI` (friday-report, cash summary per active client).

**Why one Worker instead of Workers + Pages:** Cloudflare Workers can serve
static assets and run Worker code from a single deployment (the `assets` key
in `wrangler.jsonc`). Requests that match a file in `frontend/` are served
directly with no Worker invocation; everything else (`/api/*`) runs
`backend/src/index.ts`. One `wrangler deploy`, one URL, no Pages/Workers split
to keep in sync.

## What already exists in your Cloudflare account (created 2026-07-15)

| Resource | Name | Detail |
| --- | --- | --- |
| D1 database | `invoice-rescue-db` | id `b9e84ca4-bcd2-44e7-b4f2-d2dc61e1a29f`, region WEUR |
| Schema | 4 tables + indexes | `leads`, `clients`, `invoices`, `chase_log` — tracked via `wrangler d1 migrations`, see CLAUDE.md |

## Deploy (from your machine, ~3 minutes)

```bash
# in this project folder
npm install -D wrangler typescript @cloudflare/workers-types
npx wrangler login            # opens browser, authorise your account
npx wrangler types            # generates exact binding types (optional but recommended)
npx wrangler deploy           # first deploy → gives you a workers.dev URL
```

Then attach the domain: Cloudflare dashboard → Workers & Pages → `invoice-rescue`
→ Settings → Domains & Routes → add `invoicerescue.co.uk` and `www.invoicerescue.co.uk`.
Because the domain is already on Cloudflare, this is one click, no DNS work.

## Email notifications — one manual check

The Worker emails you every new lead via Cloudflare Email Service (`NOTIFY` binding).
Requirements (both should already be true on your account):

1. Email Sending is enabled on `invoicerescue.co.uk` ✔ (`npx wrangler email sending list`)
2. `tiborcc2@gmail.com` is a **verified destination address** ✔ (required by the restricted `NOTIFY` binding)

If a lead email ever fails, the lead is still saved to D1 — notification is best-effort
by design. Check: dashboard → Email → Email Routing → Destination addresses.

## Test it

Locally (recommended first — no live traffic, no real emails):

```bash
npx wrangler d1 migrations apply invoice-rescue-db --local
printf 'GEMINI_API_KEY=your-key-here\nADMIN_SECRET=local-dev-secret\n' > .dev.vars   # gitignored
npx wrangler dev --port 8787
# in another terminal:
BASE_URL=http://127.0.0.1:8787 ADMIN_SECRET=local-dev-secret backend/test/rest-api.sh
```

`rest-api.sh` covers `/api/health`, `/api/lead`, and `/api/clients`; it prints
the manual `curl` walkthrough for the CSV/admin/chase/cron routes (they need a
seeded client first). Admin routes need `-u admin:$ADMIN_SECRET` on every
request (any username works, only the password is checked). Cron handlers can
be fired manually in local dev:
`curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"`.

Against the live deployment:

```bash
curl https://invoicerescue.co.uk/api/health

curl -X POST https://invoicerescue.co.uk/api/lead \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"name":"Test Person","email":"test@example.com","company":"Test Ltd","overdue_band":"5k_25k","message":"hello","website":""}'

npx wrangler d1 execute invoice-rescue-db --remote \
  --command "SELECT id, name, email, company, overdue_band, status, created_at FROM leads ORDER BY id DESC LIMIT 10"
```

Expected: `{"ok":true}` from the POST, one row from the SELECT, and a notification
email in your inbox with subject "New Invoice Rescue lead: Test Person — Test Ltd".

## Spam protection

- Honeypot field (`website`) silently drops bots.
- For belt-and-braces, enable a free rate-limiting rule in the dashboard:
  Security → WAF → Rate limiting rules → limit `POST /api/lead` to 5 requests/minute per IP.
  Platform-native, zero code.

## Design system

- **Colours:** `--paper:#FBFAF7` `--ink:#171B21` `--muted:#5B6470` `--rule:#DDD9CE` `--red:#B23A2E` `--green:#1E7A4E` `--green-dark:#175F3D`
- **Display font:** Fraunces (h1/h2)
- **Body font:** IBM Plex Sans, IBM Plex Mono for numbers/labels
- **Signature element:** the "aged receivables" ledger mockup in the hero

## Honest status

- **Verified by me:** D1 database created and schema applied (ran against your live
  account); `send_email` binding config and plain-object `send()` API checked against
  Cloudflare's current docs; the `assets` binding config checked against Cloudflare's
  current static-assets docs.
- **Not yet run:** the Worker itself — deploy needs your `wrangler login`.
  The logic is simple and hand-traced, but treat the first deploy + curl test as the
  real verification. If anything fails, paste the error to Claude.

## Credit-control engine — built, not yet live-hardened

CSV import, daily overdue detection, Gemini chase drafting, the `/admin`
review queue, send-on-approve, and the Friday cash report are all implemented
(see the routes table above) and verified end-to-end against local D1 + local
`wrangler dev`. Before using this with a real client:

1. **`/admin`, `/api/chase/*`, `/api/clients`, and the CSV import route are
   gated behind a single shared secret** (`ADMIN_SECRET`, checked via HTTP
   Basic Auth — see `requireAdminAuth()` in `backend/src/index.ts`). That's a
   stopgap for the "I personally know every client" stage, not real auth: no
   per-user identity, no rotation, no audit log. Put Cloudflare Access in
   front of all four before this scales past that (§4.4 of the design doc).
2. **Set `ADMIN_SECRET`** as a real secret before deploying:
   `npx wrangler secret put ADMIN_SECRET`. Any username works at the browser's
   Basic Auth prompt — only the password is checked.
3. **Verify `BOE_BASE_RATE_PERCENT` in `wrangler.jsonc`** against the current
   published Bank of England base rate before it drafts a message that states
   statutory interest — it's a hardcoded var, not fetched automatically.
4. **Confirm the escalation cadence** (`backend/src/lib/escalation.ts`,
   currently a 7/14/21-day placeholder) matches what you actually want to send.
5. **Set `GEMINI_API_KEY`** as a real secret before deploying:
   `npx wrangler secret put GEMINI_API_KEY` (it currently reuses a key shared
   with other projects in the vault — consider minting a dedicated one).

Still deliberately not built: Xero/QuickBooks OAuth sync — CSV is the
pragmatic first path until a client actually asks for live sync (§4.1, §6).

## Contact

<hello@invoicerescue.co.uk>
