<!-- Generated: 2026-09-14 | Files scanned: 31 | Token estimate: ~700 -->
# Frontend Codemap

## Page Tree & Asset Architecture

Static assets reside in `frontend/` and are served directly by Cloudflare Workers via the `assets` binding without a separate JavaScript bundler:

```text
frontend/
├── index.html                  # Main public landing page & interactive calculators
├── _headers                    # Edge security headers (CSP, HSTS, Permissions-Policy)
├── robots.txt                  # Search engine crawlers policy
├── sitemap.xml                 # Canonical XML sitemap
├── compare/
│   ├── index.html              # Credit control comparison directory
│   └── chaser/
│       └── index.html          # Competitor comparison: Invoice Rescue vs Chaser
├── privacy/
│   └── index.html              # Privacy policy & GDPR compliance notice
└── terms/
    └── index.html              # Service terms, pricing tier contracts, statutory basis
```

## Dynamic Server-Rendered UI

Dynamic views are rendered directly by Cloudflare Worker handlers:

| Route | Rendered By | Description & User Role |
| --- | --- | --- |
| `/admin` | [`backend/src/lib/admin.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/admin.ts) | Operator review queue to inspect, edit, approve, or skip staged AI drafts |
| `/portal` | [`backend/src/lib/portal.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/portal.ts) | Passwordless magic-link email login form for paying clients |
| `/portal/dashboard` | [`backend/src/lib/portal.ts`](file:///D:/Dev/Workspaces/Active/invoice-rescue/backend/src/lib/portal.ts) | Client dashboard displaying real-time debtor invoice status & human approval audit trails |

## Client-Side Interactions & State

- **Statutory Interest Calculator** ([`frontend/index.html`](file:///D:/Dev/Workspaces/Active/invoice-rescue/frontend/index.html)):
  - Dynamically computes daily interest (`BoE Base Rate + 8%`) and fixed compensation tiers (£40 / £70 / £100).
  - Fetches the active base rate from `/api/statutory-rate` on load with a local fallback.
- **Lead Intake Form** ([`frontend/index.html`](file:///D:/Dev/Workspaces/Active/invoice-rescue/frontend/index.html)):
  - AJAX submit via `fetch('POST /api/lead')`.
  - In-place submission confirmation without page reload.
- **Security Headers** ([`frontend/_headers`](file:///D:/Dev/Workspaces/Active/invoice-rescue/frontend/_headers)):
  - Enforces Strict Content-Security-Policy (CSP), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Strict-Transport-Security`.
