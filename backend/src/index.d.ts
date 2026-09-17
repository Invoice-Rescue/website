/**
 * Invoice Rescue — API Worker
 * ----------------------------------------------------
 * Routes:
 *   GET  /api/health                          → health check (incl. D1 connectivity)
 *   GET  /api/statutory-rate                   → current BOE base rate, for the landing-page calculator
 *   POST /api/lead                            → validate + store lead in D1 + email notification
 *   POST /api/clients                          → onboard a new client + best-effort Stripe customer [admin]
 *   POST /api/clients/:id/invoices/import      → CSV invoice import [admin]
 *   GET  /admin                                → chase-draft review queue [admin]
 *   POST /api/chase/:id/approve                → send an approved chase message [admin]
 *   POST /api/chase/:id/skip                    → mark a draft as skipped [admin]
 *   POST /api/billing/webhook                  → Stripe webhook (subscription status → client status)
 *   GET  /portal                               → client login form
 *   POST /portal/login                         → email a 15-min magic link [client]
 *   GET  /portal/verify                        → exchange magic link for a 7-day session cookie [client]
 *   GET  /portal/dashboard                     → client's own invoices + chase history w/ review audit trail [client]
 *   POST /portal/billing                       → redirect to Stripe-hosted billing portal [client]
 *   POST /portal/logout                        → clear session cookie [client]
 *
 * [admin] routes require HTTP Basic Auth — any username, password = ADMIN_SECRET.
 * [client] routes require a portal session cookie — see backend/src/lib/portal-auth.ts. No
 * public signup: a client record is always created by the operator via POST /api/clients first;
 * /portal/login only works for an email that already matches a clients.contact_email row.
 *
 * Cron Triggers (see wrangler.jsonc "triggers.crons"):
 *   06:00 UTC daily → detect-overdue: draft next chase step for overdue invoices
 *   08:00 UTC Fri   → friday-report: cash summary email per active client
 *
 * The landing page itself is a static asset served directly from /frontend
 * (see wrangler.jsonc "assets" config) — this Worker only ever handles
 * requests that don't match a static file, i.e. everything under /api/*, /admin, /portal.
 *
 * Bindings (see wrangler.jsonc):
 *   DB      — D1 database "invoice-rescue-db"
 *   NOTIFY  — send_email binding restricted to the operator's own inbox (lead notifications, digests)
 *   SEND    — send_email binding, unrestricted destination (chase messages, client reports, magic links)
 * Secrets (wrangler secret put):
 *   GEMINI_API_KEY
 *   ADMIN_SECRET          — password half of the Basic Auth check on admin routes, see requireAdminAuth()
 *   STRIPE_SECRET_KEY     — Stripe API key (test mode as of 2026-08; see CLAUDE.md before going live)
 *   STRIPE_WEBHOOK_SECRET — signing secret for /api/billing/webhook, from the Stripe Dashboard webhook config
 *   PORTAL_SESSION_SECRET — HMAC key for client portal magic-link + session tokens
 * Vars:
 *   NOTIFY_TO, NOTIFY_FROM, BOE_BASE_RATE_PERCENT, OPERATOR_NAME, STRIPE_PUBLISHABLE_KEY
 *
 * Email: outbound goes through Cloudflare Email Sending (DMARC-aligned via cf-bounce.invoicerescue.co.uk).
 * Inbound mail is NOT handled here — the root MX is Google Workspace, so replies land in the operator's inbox.
 *
 * /admin, /api/chase/*, /api/clients, and the CSV import route are gated by
 * requireAdminAuth() — a single shared secret (ADMIN_SECRET) checked via HTTP
 * Basic Auth. This is a stopgap for the "I personally know every client"
 * stage, not real auth: no per-user identity, no rotation, no audit log. Put
 * Cloudflare Access in front of all of them before this scales past that
 * (docs/credit-control-system-design.md §4.4).
 *
 * No external dependencies — the Stripe integration is plain fetch() calls
 * (backend/src/lib/stripe.ts), not the stripe-node SDK. ES modules format.
 */
import { runOverdueDetection } from "./lib/chase-runner";
declare const _default: ExportedHandler<Env>;
export default _default;
export { runOverdueDetection };
