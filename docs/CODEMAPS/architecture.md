<!-- Generated: 2026-09-14 | Files scanned: 31 | Token estimate: ~750 -->
# Architecture Codemap

## System Overview

Invoice Rescue is an AI-assisted credit-control service for UK service businesses. The service operates on Cloudflare Workers edge runtime backed by Cloudflare D1 SQLite with zero external runtime package dependencies.

```text
[ Browser / Client ]
      │
      ├── Static Assets (/ , /terms, /privacy, /compare/*) ──> [ Cloudflare Worker Assets ] (frontend/)
      │
      └── Dynamic API & Portals (/api/*, /admin, /portal/*) ──> [ Cloudflare Worker Router ] (backend/src/index.ts)
                                                                       │
                         ┌─────────────────────────────────────────────┼──────────────────────────────┐
                         ▼                                             ▼                              ▼
                 [ Cloudflare D1 ]                            [ External APIs ]              [ Outbound Email ]
                 (invoice-rescue-db)                           (direct fetch)                (Cloudflare Bindings)
                 - leads                                       - Google Gemini               - env.NOTIFY (Operator)
                 - clients                                     - Stripe API                  - env.SEND (Debtors/Magic links)
                 - invoices
                 - chase_log
```

## Service Boundaries

| Boundary | Technology | Primary Location | Responsibility |
| --- | --- | --- | --- |
| **Static Edge Assets** | HTML / CSS / JS | `frontend/` | Public landing page, calculators, SEO, and static legal documents |
| **API & Request Router** | Cloudflare Worker (TS) | `backend/src/index.ts` | Routing, request validation, authentication, and responses |
| **Domain Logic** | Modular TypeScript | `backend/src/lib/` | Statutory calculations, escalation cadence, AI prompt drafting, auth |
| **Scheduled Tasks** | Cloudflare Cron Triggers | `backend/src/index.ts` | Daily overdue detection (`06:00 UTC`) & weekly cash reports (`08:00 UTC Fri`) |
| **Database Layer** | Cloudflare D1 (SQLite) | `backend/db/migrations/` | Relational storage with CHECK constraints and unique guards |
| **Outbound Email** | Worker `send_email` | Cloudflare Worker Bindings | Split-trust email delivery (`NOTIFY` operator, `SEND` public) |

## Data Flows

### 1. Inbound Lead Capture

`User Form Submit` ➔ `POST /api/lead` ➔ Validate schema ➔ `INSERT INTO leads` (D1) ➔ Dispatch alert via `env.NOTIFY` ➔ Return JSON.

### 2. Overdue Chase Drafting & Review

`Daily Cron (06:00 UTC)` ➔ Query overdue `invoices` ➔ Calculate step via `nextStepDue()` ➔ Generate prompt via `buildChasePrompt()` ➔ Draft message via Gemini API ➔ `INSERT INTO chase_log (status='draft')` ➔ Operator reviews at `/admin` ➔ `POST /api/chase/:id/approve` ➔ Dispatch email via `env.SEND` ➔ Mark `status='sent'`.

### 3. Client Portal Authentication

`Client Login` ➔ `POST /portal/login` ➔ Verify client exists in `clients` ➔ Generate 15-min HMAC token ➔ Send magic link email via `env.SEND` ➔ Client clicks link ➔ `GET /portal/verify` ➔ Set 7-day HttpOnly cookie ➔ Access `/portal/dashboard` (scoped by session client ID).
