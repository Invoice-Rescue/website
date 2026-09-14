# Invoice Rescue — Architecture

This doc explains the repo layout after the 2026-07-16 reorganization: why it's
split the way it is, and where to put new things.

## The split: frontend vs. backend, one deployment

```text
                        wrangler deploy
                              │
              ┌───────────────┴───────────────┐
              │                                 │
    frontend/  (static assets)         backend/src/index.ts  (Worker)
    served directly by Cloudflare       runs only for requests that
    for any request that matches        don't match a static file —
    a file — no code runs               in practice, /api/*
              │                                 │
              ▼                                 ▼
       browser gets HTML/CSS/JS          D1 (backend/db/schema.sql)
       instantly, zero cold start        + Cloudflare Email Service
```

This is one Cloudflare Worker deployment with a static-assets binding
(`assets.directory` in `wrangler.jsonc`), not a separate Pages project plus a
separate Worker. One `wrangler deploy`, one URL, one thing to keep in sync —
deliberately simpler than the earlier Workers+Pages split this repo used to
have.

## Why this is different from the previous layout

Before this reorganization, the repo had **two competing landing page
implementations** at once:

1. A multi-page static site (`index.html` + `about/`, `contact/`,
   `how-it-works/`, `pricing/`, `who-we-help/`) built for the original
   12%-success-fee pricing model, deployed via Cloudflare Pages.
2. A single-page site with an embedded HTML template literal inside
   `index.ts`, built alongside `docs/business-plan.html` for the current
   subscription-tier pricing model, deployed via a Worker + D1.

These reflected two different pricing strategies from two different points in
the project's life — not two features that both needed to exist. The Worker
version is the one that matches the current business plan and has a live D1
database behind it, so it's the one kept. The static multi-page site was
deleted rather than archived, per your call to make this a clean break.

The embedded HTML was also pulled out of the TypeScript file into a real
`.html` file in `frontend/`. A multi-hundred-line string inside a `.ts` file
had no syntax highlighting, no browser preview, and mixed two concerns (markup
and request handling) in one file — splitting them is what makes the
`frontend/` vs `backend/` boundary real instead of cosmetic.

## Where things live, and why

| Path | What | Why here |
| --- | --- | --- |
| `frontend/index.html` | The landing page markup + inline styles + form-submit script | Static asset — Cloudflare serves it with no Worker invocation, so it loads even if the Worker has a bug |
| `frontend/robots.txt`, `frontend/sitemap.xml` | Crawler files | Must live inside the assets directory to actually be served at `/robots.txt` and `/sitemap.xml` |
| `backend/src/index.ts` | Request router for API, Admin Review Queue, Client Portal, Stripe webhooks, and Cron triggers | Server-side execution layer talking to D1, Gemini AI, Stripe, and Cloudflare Email Service |
| `backend/db/migrations/` | Versioned D1 schema migrations (`0001` through `0004`) | Tracked via `wrangler d1 migrations` for reproducible local and remote database evolution |
| `wrangler.jsonc` | Deploy config for both halves | Lives at the repo root because it's the one file that describes the whole deployment, not just one side of it |
| `docs/architecture.md` | This file | Explains structure and decisions |
| `docs/credit-control-system-design.md` | Credit-control engine system design | Architectural design for AI chasing, escalation, and accounting integration |
| `docs/business-plan.html` | The underlying business plan | Reference material, not code — kept out of the repo root so it doesn't read as part of the application |

## Adding new work

- **New frontend page or asset** → add it under `frontend/`. It's served
  automatically; no route needs to be registered.
- **New API endpoint** → add a route in `backend/src/index.ts`. If it needs
  its own file as the Worker grows, add it under `backend/src/` and import it
  — don't put request-handling logic in `frontend/`.
- **New table or migration** → add it to `backend/db/schema.sql` (or a new
  numbered migration file in `backend/db/` once there's more than one).
- **Anything that changes deploy behavior** (bindings, routes, assets config)
  → `wrangler.jsonc` at the root.
