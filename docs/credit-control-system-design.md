# Invoice Rescue — Credit-Control Engine: System Design

Status: built (2026-07-19) — CSV ingestion, overdue detection, AI drafting,
review queue, send-on-approve, and the Friday report all exist in
`backend/src/index.ts` and `backend/src/lib/`, verified against local D1 +
`wrangler dev`. Not yet done: Cloudflare Access in front of `/admin`, and
Xero/QuickBooks OAuth sync (§4.1, deliberately deferred). See README.md
"Credit-control engine" section for the pre-production checklist.
Builds on the live Cloudflare base (Worker `invoice-rescue`, D1 `invoice-rescue-db`) described in `README (1).md`. Scope = the four items that base deliberately deferred: Xero/QuickBooks sync, overdue detection, AI chase drafting + review, Friday report.

## 1. Requirements

**Functional**
- Client connects Xero, QuickBooks, or uploads a CSV of invoices.
- System detects invoices that cross their due date with no payment.
- System drafts the next escalation message (reminder → firm → formal notice w/ statutory interest) in the client's brand voice.
- Operator (you) reviews every draft before it sends — nothing goes out unreviewed.
- Approved messages send in the client's name to the debtor.
- Every Friday, each client gets an automated cash report: paid / promised / escalating.

**Non-functional**
- Solo operator, no engineering team — every new moving part has to be maintainable by one person in spare hours.
- Cost discipline: the base runs at £0/month. Anything added should be justified against that baseline, not assumed free.
- Low volume for the foreseeable future — plan tiers cap at 15/40/unlimited active invoices per client, and the 90-day goal is 2–3 clients total. Design for correctness and low maintenance, not scale.
- Deliverability matters disproportionately: a chase email that lands in spam is a failed product, not a minor bug.

**Constraints / what already exists**
- Stack: Cloudflare Worker (TypeScript, ES modules, `nodejs_compat`), D1 (`invoice-rescue-db`), Cloudflare Email Service (`NOTIFY` binding, currently restricted to your own inbox only).
- Schema already live: `leads`, `clients`, `invoices`, `chase_log` — see §3 for the additions this design needs on top of them.
- Domain `invoicerescue.co.uk` is on Cloudflare — DNS/Email Routing is already in your control, which simplifies SPF/DKIM setup for any sending option.
- Fixed today in this session: `wrangler.jsonc` pointed at `src/index.ts`, a file that doesn't exist — the real file is `index.ts` at repo root. Deploy would have 404'd on this. Changed `main` to `index.ts`.

## 2. High-Level Design

```
Xero/QuickBooks ──OAuth──▶  ┌────────────────────┐
CSV upload      ──────────▶ │  sync (on-demand +  │
                              │  scheduled refresh) │──▶ invoices (D1)
                              └────────────────────┘
                                                             │
                              ┌────────────────────┐         │ daily 06:00 UTC
                              │  Cron Trigger:      │◀────────┘
                              │  detect-overdue      │
                              └────────────────────┘
                                        │ for each newly-overdue / due-for-next-step invoice
                                        ▼
                              ┌────────────────────┐
                              │  AI draft (Gemini)   │──▶ chase_log (status='draft')
                              └────────────────────┘
                                        │ digest email: "N drafts ready"
                                        ▼
                              ┌────────────────────┐
                              │  Review queue         │  (Cloudflare Access-gated /admin)
                              │  approve / edit / skip │
                              └────────────────────┘
                                        │ approve
                                        ▼
                              ┌────────────────────┐
                              │  Send (transactional  │──▶ debtor inbox
                              │  provider, see §5.4)  │
                              └────────────────────┘

                              ┌────────────────────┐
                              │  Cron Trigger:        │
                              │  friday-report        │──▶ client inbox
                              └────────────────────┘
```

Everything new is either a Worker route (`/admin/*`, `/api/sync/*`) or a Cron Trigger on the same Worker — no new services, no new hosting.

## 3. Data Model Additions

The existing four tables don't need to change shape, but two need new columns and one new table is needed:

```sql
-- invoices: link back to the accounting source record for idempotent re-sync
ALTER TABLE invoices ADD COLUMN external_id TEXT;         -- Xero/QB invoice ID, NULL for CSV
ALTER TABLE invoices ADD COLUMN last_synced_at TEXT;

-- chase_log: it currently only records *sent* actions. Extend it to also hold drafts
-- awaiting review, so there's one audit trail instead of two tables to reconcile.
ALTER TABLE chase_log ADD COLUMN body TEXT;                -- the actual drafted/sent message
ALTER TABLE chase_log ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
  -- draft | approved | sent | skipped | bounced
ALTER TABLE chase_log ADD COLUMN reviewed_at TEXT;

-- new: one row per client per accounting connection
CREATE TABLE accounting_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  provider TEXT NOT NULL,              -- xero | quickbooks
  tenant_id TEXT,                      -- Xero org / QB realm id
  access_token TEXT NOT NULL,          -- see §5.1 on encryption
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'  -- active | expired | revoked
);
```

Reused, not duplicated: `chase_log.status='draft'` rows are exactly what the review queue lists. On approve, the row flips to `approved` then `sent` — no separate drafts table to keep in sync.

## 4. Component Deep-Dives

### 4.1 Accounting sync (Xero / QuickBooks / CSV)
- OAuth 2.0 for both providers (Xero: Authorization Code flow; QuickBooks: OAuth 2.0 via Intuit). Tokens stored in `accounting_connections`, refreshed on a schedule (both providers issue short-lived access tokens, ~30–60 min, with longer-lived refresh tokens).
- **Open question, not guessed here:** exact Xero/QuickBooks token lifetimes and refresh-token rotation rules change between their API versions — verify against Xero's and Intuit's current developer docs before implementing the refresh logic, don't hardcode assumed expiry windows.
- CSV path stays the escape hatch it already is in the plan — map columns to `invoices`, no OAuth, no token maintenance. Given the 90-day goal is 2–3 clients, **CSV-first is the pragmatic build order**: it unblocks the AI drafting and review pipeline immediately without OAuth complexity, and Xero/QuickBooks sync can follow once a client actually asks for it.
- Sync runs on a schedule (e.g. every 6h via Cron Trigger) plus on-demand from `/admin`.

### 4.2 Overdue detection (Cron Trigger)
- Daily job, `03:00` client-local-equivalent (pick one fixed UTC time, e.g. `06:00 UTC` — good enough for a UK-only client base for now).
- Query: `invoices` where `status='overdue' AND due_date < today`, joined against `chase_log` to find the highest `step` already sent per invoice, so it knows whether the next message is a reminder (step 1), firm follow-up (step 2), or formal notice (step 3).
- Cadence between steps (e.g. 7 days after due, 14 days, 21 days) is a business decision, not an engineering one — flag this as something to confirm against the actual escalation sequence design, not assume a number here.

### 4.3 AI drafting (Gemini)
- Called from the Cron Trigger's Worker context via `fetch()` to the Gemini API — this is the one component with a real per-use cost, unlike the rest of the £0/month base. At solo/early-client volume (a handful of clients, a few messages/day) this is genuinely small, but it's worth tracking from day one rather than discovering it later.
- Prompt inputs: client's brand voice notes (new field needed on `clients`, e.g. `voice_notes TEXT`), debtor name, invoice details, escalation step, statutory interest calculation (Late Payment of Commercial Debts Act — this calculation is deterministic and should be computed in code, not left to the model, then handed to Gemini as a fact to include).
- Output written to `chase_log` as `status='draft'`.

### 4.4 Review queue + admin auth
- No auth system exists yet in the Worker — everything today is public (by design, it's just a landing page). The review queue and any accounting credentials must not be public.
- **Recommended: Cloudflare Access** in front of `/admin/*`. Zero code, free for your team size (single user), policy = allow `tiborcc2@gmail.com` only. This matches the pattern already used in the base (platform-native, zero-cost controls over custom code) rather than building a login system.
- Review UI can be as plain as a server-rendered HTML table (consistent with the no-build-step approach already in use) — list drafts, edit textarea, Approve/Skip buttons posting to `/api/chase/:id/approve`.

### 4.5 Sending — the one real trade-off in this design

Verified against Cloudflare's current Email Service docs before writing this:

| | Cloudflare Email Service (`send_email` binding) | Dedicated transactional provider (e.g. Resend, Postmark) |
|---|---|---|
| Cost | Free, already on the account | Free tier (~3,000/mo on Resend), paid beyond that |
| Setup | Domain already onboarded for the `NOTIFY` binding; a *new* binding without `destination_address`/`allowed_destination_addresses` restrictions is needed to send to arbitrary debtor addresses | New account + API key, SPF/DKIM on the same domain |
| Deliverability tooling | Docs confirm outbound sends via Workers are logged as "dropped" in the Email Routing summary even when delivered — you'd rely on separate Email sending metrics/logs, and there's no built-in bounce/complaint webhook | Purpose-built for transactional mail: bounce, complaint, and open/click webhooks out of the box |
| Reply handling | Possible via Email Routing inbound rules back into the Worker, but you'd build the reply-threading yourself | Same amount of custom work either way — this isn't a differentiator |
| Compliance | You are responsible either way for CAN-SPAM/GDPR unsubscribe mechanics — Cloudflare's docs are explicit that this isn't handled for you | Same |

**Recommendation:** start with Cloudflare Email Service for the *first* real client, since it's zero marginal cost and the volume is trivial (dozens of emails/week at most) — but treat "switch to a dedicated provider" as the first thing to revisit once you have a client and can see actual bounce/spam behavior. This is exactly the kind of thing the existing README's "sell first" philosophy already gets right — don't pre-build deliverability infrastructure for a problem you don't have evidence of yet.

### 4.6 Friday cash report
- Second Cron Trigger, Fridays only. Per active client: query `invoices` (paid this week / promised — i.e. debtor replied via review-queue-recorded outcome / still escalating), render the same three-bucket structure already promised in the landing page copy, send via the same binding chosen in §4.5.

## 5. Trade-offs Made Explicit

- **D1 vs. extending the existing Firebase app**: the credit-control engine's data (invoices, chase history, accounting tokens) stays in D1, co-located with the Worker that acts on it — not pushed into the separate Firebase-backed core app. Keeps this system self-contained and avoids a cross-service dependency for something that runs on a schedule; the trade-off is you now have two data stores across your two products instead of one, which is a real cost if you ever want a single unified view of a client.
- **`accounting_connections.access_token` stored as plain `TEXT`**: D1 has no native column encryption. For a first build with 2–3 clients this is a documented, accepted risk — not an oversight — but flag it for revisit before scaling past a handful of clients: options are application-level encryption with a key in Worker secrets, or moving tokens to a KV namespace with `expiration`.
- **CSV-first over OAuth-first** (§4.1): ships the AI drafting/review loop — the actual product — weeks earlier, at the cost of manual CSV re-upload until a client requests live sync.

## 6. What NOT to Build Yet

Consistent with the existing base's philosophy: don't build accounting OAuth until a client asks for it (CSV covers the first sale); don't build a dedicated-provider email migration until Cloudflare Email Service actually shows a deliverability problem; don't encrypt tokens you don't have yet. Build order: CSV ingestion → cron detection → AI draft → review queue (Access-gated) → send via existing binding → Friday report. Each step is independently shippable and testable with `curl`, matching the existing `README (1).md` testing pattern.
