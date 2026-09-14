# Project Memory: Invoice Rescue

## Core Architecture
- **Worker & Static Split**: One Cloudflare Worker (`backend/src/index.ts`) and static assets (`frontend/`) deployed via `wrangler deploy`.
- **Database**: Cloudflare D1 (`invoice-rescue-db`) managed via `backend/db/migrations/*.sql`.
- **Email**: Cloudflare Send Email bindings: `NOTIFY` (operator inbox only) and `SEND` (unrestricted for debtor/client communications).
- **Billing**: Stripe self-serve billing portal with webhook syncing client status in D1.
- **Client Portal**: Magic-link HMAC login (`/portal/login` -> `/portal/verify`) and 7-day session cookie.
- **Admin**: HTTP Basic Auth (`ADMIN_SECRET`) at `/admin` and `/api/clients`.

## Key Verification Commands
- `npm run verify`: Runs markdown linting, TypeScript typecheck, unit test suite, and dry-run bundle build.
- `npm test`: Runs automated unit tests via `tsx --test tests/**/*.test.ts`.
- `npm run db:seed`: Seeds local D1 database with sample test client, invoices, and draft chase log.

## Operational Constraints & Compliance
- **Late Payment Act**: BOE Base Rate (currently 3.75%) + 8% margin. Statutory compensation tiers: £40 (<£1,000), £70 (£1,000-£9,999.99), £100 (>=£10,000).
- **PECR Cold Outreach**: Strictly restricted to Ltd/LLP entities (Corporate Subscribers) under legitimate interest. Solo sole traders require opt-in consent.
- **Human-in-the-Loop**: All AI-drafted chase messages start as `status='draft'` in `chase_log` and must be manually approved or skipped by the operator at `/admin`.
