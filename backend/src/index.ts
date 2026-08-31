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
 *   NOTIFY_TO, NOTIFY_FROM, BOE_BASE_RATE_PERCENT, OPERATOR_NAME, STRIPE_PUBLISHABLE_KEY, INBOX_FORWARD_TO
 *
 * Inbound email (Email Routing → email() handler below): every address on invoicerescue.co.uk
 * currently forwards straight to tibor@invoicerescue.co.uk via a Cloudflare Email Routing rule
 * that bypasses this Worker entirely. The email() handler exists so that rule *can* be pointed
 * at this Worker (Dashboard, or `wrangler email routing rules create`), at which point it just
 * logs-and-forwards to the same address — no behavior change until you also want to do something
 * with debtor/client replies (parse + store + surface in /admin, see routing.md's DO pattern).
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

import { parseCsv } from "./lib/csv";
import { fixedCompensationPence, statutoryInterestPence } from "./lib/statutory-interest";
import { nextStepDue, STEP_LABELS, type ChaseHistoryRow } from "./lib/escalation";
import { buildChasePrompt, draftChaseMessage } from "./lib/gemini";
import { renderReviewQueue, type DraftRow } from "./lib/admin";
import {
  signLoginToken,
  verifyLoginToken,
  buildSessionCookie,
  clearSessionCookie,
  authenticateClient,
} from "./lib/portal-auth";
import { createCustomer, createBillingPortalSession, verifyWebhookSignature } from "./lib/stripe";
import {
  renderPortalLogin,
  renderPortalLoginSent,
  renderPortalDashboard,
  type PortalClientRow,
  type PortalInvoiceRow,
  type PortalChaseRow,
} from "./lib/portal";

/** Minimal interface for the send_email binding's plain-object API.
 * Run `npx wrangler types` to generate exact, up-to-date binding types. */
interface EmailSender {
  send(message: { to: string; from: string; subject: string; text?: string; html?: string }): Promise<unknown>;
}

interface Env {
  DB: D1Database;
  NOTIFY: EmailSender;
  SEND: EmailSender;
  NOTIFY_TO: string;
  NOTIFY_FROM: string;
  BOE_BASE_RATE_PERCENT: string;
  OPERATOR_NAME: string;
  GEMINI_API_KEY: string;
  ADMIN_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  PORTAL_SESSION_SECRET: string;
  INBOX_FORWARD_TO: string;
}

interface LeadInput {
  name: string;
  email: string;
  company: string;
  overdue_band: string;
  message: string;
  website: string; // honeypot — must be empty
}

/** Allowed values for the "how much is overdue" select. */
const OVERDUE_BANDS = new Set(["under_5k", "5k_25k", "25k_100k", "over_100k", "not_sure"]);

/** Matches the `plan`/`accounting_source` check constraints implied by schema.sql's column comments. */
const PLANS = new Set(["foundation", "engine", "operator"]);
const ACCOUNTING_SOURCES = new Set(["xero", "quickbooks", "csv"]);

interface ClientInput {
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  accounting_source: string;
  voice_notes: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Cheap but effective at 1-2 clients: a single shared secret, not a real auth
// system. HTTP Basic Auth (not Bearer) is deliberate — /admin is a
// server-rendered HTML page with plain <form> POSTs, and a browser has no way
// to attach a custom Authorization header to a form submission. Basic Auth is
// the one scheme browsers natively prompt for and then re-send automatically
// on every later request to the origin, so the review-queue forms keep
// working after the first login. Swap this for something real (Cloudflare
// Access, or actual sessions) once you're past the "I personally know every
// client" stage — but ship THIS first, not nothing.
function requireAdminAuth(request: Request, env: Env): Response | null {
  const match = request.headers.get("Authorization")?.match(/^Basic (.+)$/);
  const password = match ? atob(match[1]).slice(atob(match[1]).indexOf(":") + 1) : null;

  if (password === null || password !== env.ADMIN_SECRET) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
    });
  }
  return null; // null = passed, continue to the real handler
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/api/health") {
        return await handleHealth(env);
      }

      if (request.method === "GET" && path === "/api/statutory-rate") {
        return Response.json(
          { boeBaseRatePercent: Number(env.BOE_BASE_RATE_PERCENT) },
          { headers: { ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" } },
        );
      }

      if (request.method === "POST" && path === "/api/billing/webhook") {
        return await handleBillingWebhook(request, env);
      }

      if (request.method === "GET" && path === "/portal") {
        return await handlePortalLoginPage(request, env);
      }

      if (request.method === "POST" && path === "/portal/login") {
        return await handlePortalLoginRequest(request, env);
      }

      if (request.method === "GET" && path === "/portal/verify") {
        return await handlePortalVerify(request, env);
      }

      if (request.method === "POST" && path === "/portal/logout") {
        return new Response(null, {
          status: 303,
          headers: { ...SECURITY_HEADERS, "Set-Cookie": clearSessionCookie(), Location: "/portal" },
        });
      }

      if (request.method === "GET" && path === "/portal/dashboard") {
        return await handlePortalDashboard(request, env);
      }

      if (request.method === "POST" && path === "/portal/billing") {
        return await handlePortalBilling(request, env);
      }

      if (request.method === "POST" && path === "/api/lead") {
        return await handleLead(request, env);
      }

      if (request.method === "POST" && path === "/api/clients") {
        return requireAdminAuth(request, env) ?? (await handleCreateClient(request, env));
      }

      const importMatch = path.match(/^\/api\/clients\/(\d+)\/invoices\/import$/);
      if (request.method === "POST" && importMatch) {
        return requireAdminAuth(request, env) ?? (await handleInvoiceImport(request, env, importMatch[1]));
      }

      if (request.method === "GET" && path === "/admin") {
        return requireAdminAuth(request, env) ?? (await handleAdminReviewQueue(env));
      }

      const approveMatch = path.match(/^\/api\/chase\/(\d+)\/approve$/);
      if (request.method === "POST" && approveMatch) {
        return requireAdminAuth(request, env) ?? (await handleChaseApprove(request, env, approveMatch[1]));
      }

      const skipMatch = path.match(/^\/api\/chase\/(\d+)\/skip$/);
      if (request.method === "POST" && skipMatch) {
        return requireAdminAuth(request, env) ?? (await handleChaseSkip(request, env, skipMatch[1]));
      }

      return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    } catch (err) {
      // Never leak internals to the client; log for observability.
      console.error("Unhandled error:", err instanceof Error ? err.stack : err);
      return Response.json(
        { ok: false, error: "Something went wrong. Please email hello@invoicerescue.co.uk." },
        { status: 500, headers: SECURITY_HEADERS },
      );
    }
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (event.cron === "0 6 * * *") {
      await runOverdueDetection(env);
    } else if (event.cron === "0 8 * * FRI") {
      await runFridayReport(env);
    }
  },

  // ponytail: log-and-forward only. Upgrade to parse (postal-mime) + store once a debtor/client
  // reply needs to show up in /admin rather than just landing in the operator's own inbox.
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    console.log(`Inbound email: ${message.from} -> ${message.to} (${message.headers.get("subject") ?? "no subject"})`);
    await message.forward(env.INBOX_FORWARD_TO);
  },
} satisfies ExportedHandler<Env>;

/** Parse, validate, store, and notify for a new lead. */
async function handleLead(request: Request, env: Env): Promise<Response> {
  const lead = await parseLead(request);

  // Honeypot: bots fill every field. Real users never see "website".
  if (lead.website !== "") {
    // Pretend success so bots don't adapt.
    return leadSuccessResponse(request);
  }

  const errors = validateLead(lead);
  if (errors.length > 0) {
    return Response.json({ ok: false, error: errors.join(" ") }, { status: 400, headers: SECURITY_HEADERS });
  }

  // Store the lead first — capturing it matters more than notifying.
  await env.DB.prepare(
    `INSERT INTO leads (name, email, company, overdue_band, message, source)
     VALUES (?1, ?2, ?3, ?4, ?5, 'landing_page')`,
  )
    .bind(lead.name, lead.email, lead.company, lead.overdue_band, lead.message)
    .run();

  // Email notification is best-effort: a failure here must not lose the lead.
  try {
    await env.NOTIFY.send({
      to: env.NOTIFY_TO,
      from: env.NOTIFY_FROM,
      subject: `New Invoice Rescue lead: ${lead.name}${lead.company ? " — " + lead.company : ""}`,
      text: [
        "New free-audit request from the landing page.",
        "",
        `Name:    ${lead.name}`,
        `Email:   ${lead.email}`,
        `Company: ${lead.company || "—"}`,
        `Overdue: ${lead.overdue_band}`,
        "",
        "Message:",
        lead.message || "—",
        "",
        "Reply within 4 working hours for best conversion.",
      ].join("\n"),
    });
  } catch (err) {
    console.error("Lead saved but notification email failed:", err);
  }

  return leadSuccessResponse(request);
}

/** Accepts both HTML form posts (no-JS fallback) and JSON (fetch). */
async function parseLead(request: Request): Promise<LeadInput> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let raw: Record<string, unknown> = {};

  if (contentType.includes("application/json")) {
    raw = (await request.json()) as Record<string, unknown>;
  } else {
    const form = await request.formData();
    raw = Object.fromEntries(form.entries());
  }

  const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

  return {
    name: str(raw.name, 120),
    email: str(raw.email, 200),
    company: str(raw.company, 160),
    overdue_band: str(raw.overdue_band, 20),
    message: str(raw.message, 2000),
    website: str(raw.website, 200),
  };
}

function validateLead(lead: LeadInput): string[] {
  const errors: string[] = [];
  if (lead.name.length < 2) errors.push("Please tell us your name.");
  // Pragmatic email shape check — full RFC validation isn't worth the complexity.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) {
    errors.push("That email address doesn't look right.");
  }
  if (!OVERDUE_BANDS.has(lead.overdue_band)) {
    errors.push("Please pick how much is currently overdue.");
  }
  return errors;
}

/** JSON for fetch clients; redirect for plain HTML form posts. */
function leadSuccessResponse(request: Request): Response {
  const accepts = request.headers.get("Accept") ?? "";
  if (accepts.includes("application/json")) {
    return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
  }
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, Location: "/#thanks" },
  });
}

/** Onboard a new client. Before this route existed, the only way to add one was a raw
 * `wrangler d1 execute ... INSERT INTO clients` command — the actual manual step this closes. */
async function handleCreateClient(request: Request, env: Env): Promise<Response> {
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const input: ClientInput = {
    company_name: str(raw.company_name, 160),
    contact_name: str(raw.contact_name, 120),
    contact_email: str(raw.contact_email, 200),
    plan: str(raw.plan, 20) || "engine",
    accounting_source: str(raw.accounting_source, 20) || "csv",
    voice_notes: str(raw.voice_notes, 2000),
  };

  const errors: string[] = [];
  if (input.company_name.length < 2) errors.push("Company name is required.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.contact_email)) {
    errors.push("A valid contact email is required.");
  }
  if (!PLANS.has(input.plan)) errors.push("Plan must be foundation, engine, or operator.");
  if (!ACCOUNTING_SOURCES.has(input.accounting_source)) {
    errors.push("Accounting source must be xero, quickbooks, or csv.");
  }
  if (errors.length > 0) {
    return Response.json({ ok: false, error: errors.join(" ") }, { status: 400, headers: SECURITY_HEADERS });
  }

  const result = await env.DB.prepare(
    `INSERT INTO clients (company_name, contact_name, contact_email, plan, status, accounting_source, voice_notes)
     VALUES (?1, ?2, ?3, ?4, 'onboarding', ?5, ?6)`,
  )
    .bind(
      input.company_name,
      input.contact_name || null,
      input.contact_email,
      input.plan,
      input.accounting_source,
      input.voice_notes || null,
    )
    .run();

  const clientId = result.meta.last_row_id;

  // Best-effort: the client portal/billing needs a Stripe customer, but Stripe being briefly
  // unreachable must not block onboarding — a missing stripe_customer_id just makes
  // /portal/billing show "not set up yet" until this is retried (see CLAUDE.md known gaps).
  try {
    const stripeCustomerId = await createCustomer(env.STRIPE_SECRET_KEY, {
      name: input.company_name,
      email: input.contact_email,
    });
    if (stripeCustomerId) {
      await env.DB.prepare(`UPDATE clients SET stripe_customer_id = ?2 WHERE id = ?1`).bind(clientId, stripeCustomerId).run();
    }
  } catch (err) {
    console.error(`Stripe customer creation failed for client ${clientId}:`, err);
  }

  return Response.json({ ok: true, id: clientId }, { status: 201, headers: SECURITY_HEADERS });
}

/** CSV columns expected: debtor_name, debtor_email, invoice_number, amount, currency, issued_date, due_date.
 * amount is major currency units (e.g. "1234.56"), converted to pence on insert. */
async function handleInvoiceImport(request: Request, env: Env, clientIdParam: string): Promise<Response> {
  const clientId = Number(clientIdParam);
  const client = await env.DB.prepare(`SELECT id FROM clients WHERE id = ?1`).bind(clientId).first();
  if (!client) {
    return Response.json({ ok: false, error: "Client not found." }, { status: 404, headers: SECURITY_HEADERS });
  }

  const text = await request.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return Response.json(
      { ok: false, error: "CSV is empty or has no data rows." },
      { status: 400, headers: SECURITY_HEADERS },
    );
  }

  let imported = 0;
  const errors: string[] = [];
  for (const [i, row] of rows.entries()) {
    const debtorName = row.debtor_name?.trim();
    const invoiceNumber = row.invoice_number?.trim();
    const dueDate = row.due_date?.trim();
    const amount = Number(row.amount);
    if (!debtorName || !invoiceNumber || !dueDate || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`Row ${i + 2}: missing or invalid required field (debtor_name, invoice_number, amount, due_date).`);
      continue;
    }
    await env.DB.prepare(
      `INSERT INTO invoices
         (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, external_id, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'overdue', NULL, datetime('now'))`,
    )
      .bind(
        clientId,
        debtorName,
        row.debtor_email?.trim() || null,
        invoiceNumber,
        Math.round(amount * 100),
        row.currency?.trim() || "GBP",
        row.issued_date?.trim() || null,
        dueDate,
      )
      .run();
    imported++;
  }

  return Response.json({ ok: true, imported, errors }, { headers: SECURITY_HEADERS });
}

async function handleAdminReviewQueue(env: Env): Promise<Response> {
  const drafts = await env.DB.prepare(
    `SELECT cl.id, cl.step, cl.body, cl.subject, i.invoice_number, i.debtor_name, i.debtor_email, c.company_name
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     JOIN clients c ON c.id = i.client_id
     WHERE cl.status = 'draft'
     ORDER BY cl.sent_at ASC`,
  ).all<DraftRow>();

  return new Response(renderReviewQueue(drafts.results ?? []), {
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleChaseApprove(request: Request, env: Env, chaseIdParam: string): Promise<Response> {
  const chaseId = Number(chaseIdParam);
  const row = await env.DB.prepare(
    `SELECT cl.id, cl.body, cl.subject, i.debtor_email, i.invoice_number
     FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id
     WHERE cl.id = ?1 AND cl.status = 'draft'`,
  )
    .bind(chaseId)
    .first<{ id: number; body: string | null; subject: string | null; debtor_email: string | null; invoice_number: string }>();

  if (!row) {
    return Response.json(
      { ok: false, error: "Draft not found or already reviewed." },
      { status: 404, headers: SECURITY_HEADERS },
    );
  }
  if (!row.debtor_email) {
    return Response.json(
      { ok: false, error: "Invoice has no debtor email on file." },
      { status: 422, headers: SECURITY_HEADERS },
    );
  }

  // The review queue's textarea lets the operator edit the draft before sending.
  let body = row.body ?? "";
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const edited = form.get("body");
    if (typeof edited === "string" && edited.trim()) body = edited;
  }

  await env.SEND.send({
    to: row.debtor_email,
    from: env.NOTIFY_FROM,
    subject: row.subject ?? `Re: Invoice ${row.invoice_number}`,
    text: body,
  });

  await env.DB.prepare(
    `UPDATE chase_log SET status = 'sent', body = ?2, outcome = 'sent', reviewed_at = datetime('now'), reviewed_by = ?3 WHERE id = ?1`,
  )
    .bind(chaseId, body, env.OPERATOR_NAME)
    .run();

  return adminActionResponse(request);
}

async function handleChaseSkip(request: Request, env: Env, chaseIdParam: string): Promise<Response> {
  const chaseId = Number(chaseIdParam);
  await env.DB.prepare(
    `UPDATE chase_log SET status = 'skipped', reviewed_at = datetime('now') WHERE id = ?1 AND status = 'draft'`,
  )
    .bind(chaseId)
    .run();
  return adminActionResponse(request);
}

/** JSON for fetch clients; redirect back to the review queue for plain HTML form posts. */
function adminActionResponse(request: Request): Response {
  const accepts = request.headers.get("Accept") ?? "";
  if (accepts.includes("application/json")) {
    return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
  }
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/admin" } });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch (err) {
    console.error("Health check: DB unreachable:", err);
    return Response.json({ ok: false, service: "invoice-rescue", db: "unreachable" }, { status: 503, headers: SECURITY_HEADERS });
  }
  return Response.json({ ok: true, service: "invoice-rescue" }, { headers: SECURITY_HEADERS });
}

async function handlePortalLoginPage(request: Request, env: Env): Promise<Response> {
  const clientId = await authenticateClient(request, env.PORTAL_SESSION_SECRET);
  if (clientId !== null) {
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/portal/dashboard" } });
  }
  return new Response(renderPortalLogin(), { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

/** Emails a 15-minute magic link if the address matches a client. Always responds the same way,
 * whether or not it matched, so this can't be used to enumerate client email addresses. */
async function handlePortalLoginRequest(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let email = "";
  if (contentType.includes("application/json")) {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    email = typeof raw.email === "string" ? raw.email.trim() : "";
  } else {
    const form = await request.formData();
    email = String(form.get("email") ?? "").trim();
  }

  const client = await env.DB.prepare(`SELECT id FROM clients WHERE contact_email = ?1`).bind(email).first<{ id: number }>();
  if (client) {
    const token = await signLoginToken(client.id, env.PORTAL_SESSION_SECRET);
    const verifyUrl = `${new URL(request.url).origin}/portal/verify?token=${token}`;
    try {
      await env.SEND.send({
        to: email,
        from: env.NOTIFY_FROM,
        subject: "Your Invoice Rescue login link",
        text: `Click to log in to your Invoice Rescue dashboard (expires in 15 minutes):\n\n${verifyUrl}\n\nDidn't request this? You can ignore this email.`,
      });
    } catch (err) {
      console.error("Portal login email failed:", err);
    }
  }

  return new Response(renderPortalLoginSent(), { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

async function handlePortalVerify(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const clientId = await verifyLoginToken(token, env.PORTAL_SESSION_SECRET);
  if (clientId === null) {
    return new Response(renderPortalLogin("That link is invalid or has expired. Request a new one below."), {
      status: 400,
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const cookie = await buildSessionCookie(clientId, env.PORTAL_SESSION_SECRET);
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, "Set-Cookie": cookie, Location: "/portal/dashboard" },
  });
}

async function handlePortalDashboard(request: Request, env: Env): Promise<Response> {
  const clientId = await authenticateClient(request, env.PORTAL_SESSION_SECRET);
  if (clientId === null) {
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/portal" } });
  }

  const client = await env.DB.prepare(`SELECT id, company_name, contact_name, stripe_customer_id FROM clients WHERE id = ?1`)
    .bind(clientId)
    .first<PortalClientRow>();
  if (!client) {
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/portal" } });
  }

  const invoices = await env.DB.prepare(
    `SELECT invoice_number, debtor_name, amount_pence, currency, status, due_date
     FROM invoices WHERE client_id = ?1 ORDER BY due_date DESC`,
  )
    .bind(clientId)
    .all<PortalInvoiceRow>();

  const chases = await env.DB.prepare(
    `SELECT i.invoice_number, cl.step, cl.status, cl.sent_at, cl.reviewed_at, cl.reviewed_by
     FROM chase_log cl JOIN invoices i ON i.id = cl.invoice_id
     WHERE i.client_id = ?1 ORDER BY cl.sent_at DESC`,
  )
    .bind(clientId)
    .all<PortalChaseRow>();

  return new Response(renderPortalDashboard(client, invoices.results ?? [], chases.results ?? []), {
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handlePortalBilling(request: Request, env: Env): Promise<Response> {
  const clientId = await authenticateClient(request, env.PORTAL_SESSION_SECRET);
  if (clientId === null) {
    return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/portal" } });
  }

  const client = await env.DB.prepare(`SELECT stripe_customer_id FROM clients WHERE id = ?1`)
    .bind(clientId)
    .first<{ stripe_customer_id: string | null }>();

  if (!client?.stripe_customer_id) {
    return new Response(
      `<!doctype html><html><body><p>Billing isn't set up on your account yet — email <a href="mailto:hello@invoicerescue.co.uk">hello@invoicerescue.co.uk</a>.</p><p><a href="/portal/dashboard">Back to dashboard</a></p></body></html>`,
      { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const returnUrl = `${new URL(request.url).origin}/portal/dashboard`;
  const portalUrl = await createBillingPortalSession(env.STRIPE_SECRET_KEY, client.stripe_customer_id, returnUrl);
  if (!portalUrl) {
    return Response.json({ ok: false, error: "Couldn't reach Stripe. Try again shortly." }, { status: 502, headers: SECURITY_HEADERS });
  }
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: portalUrl } });
}

/** Stripe webhook — keeps client.status in sync with subscription state. Not FCA/legal-advice-relevant;
 * purely operational (see CLAUDE.md for the manual Stripe Dashboard setup this endpoint depends on). */
async function handleBillingWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const valid = await verifyWebhookSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return Response.json({ ok: false, error: "Invalid signature." }, { status: 400, headers: SECURITY_HEADERS });
  }

  const event = JSON.parse(rawBody) as { type: string; data: { object: { customer: string; status?: string } } };
  const customerId = event.data.object.customer;

  if (event.type === "customer.subscription.deleted") {
    await env.DB.prepare(`UPDATE clients SET status = 'churned' WHERE stripe_customer_id = ?1`).bind(customerId).run();
  } else if (event.type === "customer.subscription.updated") {
    const subStatus = event.data.object.status;
    const newStatus =
      subStatus === "active" || subStatus === "trialing"
        ? "active"
        : subStatus === "past_due" || subStatus === "unpaid" || subStatus === "incomplete_expired"
          ? "paused"
          : subStatus === "canceled"
            ? "churned"
            : null;
    if (newStatus) {
      await env.DB.prepare(`UPDATE clients SET status = ?2 WHERE stripe_customer_id = ?1`).bind(customerId, newStatus).run();
    }
  } else if (event.type === "invoice.payment_failed") {
    try {
      await env.NOTIFY.send({
        to: env.NOTIFY_TO,
        from: env.NOTIFY_FROM,
        subject: "Invoice Rescue: a client payment failed",
        text: `Stripe customer ${customerId} had a failed payment. Check the Stripe dashboard.`,
      });
    } catch (err) {
      console.error("Payment-failure notification email failed:", err);
    }
  }

  return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
}

interface OverdueInvoiceRow {
  id: number;
  client_id: number;
  debtor_name: string;
  debtor_email: string | null;
  invoice_number: string;
  amount_pence: number;
  currency: string;
  due_date: string;
  days_overdue: number;
  company_name: string;
  voice_notes: string | null;
}

/** Cron: draft the next escalation step for every invoice that's due for one. */
async function runOverdueDetection(env: Env): Promise<void> {
  const overdue = await env.DB.prepare(
    `SELECT i.id, i.client_id, i.debtor_name, i.debtor_email, i.invoice_number, i.amount_pence, i.currency, i.due_date,
            CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
            c.company_name, c.voice_notes
     FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.status = 'overdue' AND i.due_date < date('now')`,
  ).all<OverdueInvoiceRow>();

  const boeBaseRatePercent = Number(env.BOE_BASE_RATE_PERCENT);

  for (const inv of overdue.results ?? []) {
    const history = await env.DB.prepare(`SELECT step FROM chase_log WHERE invoice_id = ?1`)
      .bind(inv.id)
      .all<ChaseHistoryRow>();

    const step = nextStepDue(inv.days_overdue, history.results ?? []);
    if (step === null) continue;

    const interest = statutoryInterestPence(inv.amount_pence, inv.days_overdue, boeBaseRatePercent);
    const compensation = fixedCompensationPence(inv.amount_pence);
    const prompt = buildChasePrompt({
      clientVoiceNotes: inv.voice_notes,
      debtorName: inv.debtor_name,
      invoiceNumber: inv.invoice_number,
      amountPence: inv.amount_pence,
      currency: inv.currency,
      dueDate: inv.due_date,
      daysOverdue: inv.days_overdue,
      step,
      stepLabel: STEP_LABELS[step],
      statutoryInterestPence: interest,
      fixedCompensationPence: compensation,
    });

    let body: string;
    try {
      body = await draftChaseMessage(env.GEMINI_API_KEY, prompt);
    } catch (err) {
      console.error(`Gemini draft failed for invoice ${inv.id}:`, err);
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO chase_log (invoice_id, step, channel, subject, outcome, status, body)
       VALUES (?1, ?2, 'email', ?3, NULL, 'draft', ?4)`,
    )
      .bind(inv.id, step, `Re: Invoice ${inv.invoice_number}`, body)
      .run();
  }

  const draftCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM chase_log WHERE status = 'draft'`).first<{
    n: number;
  }>();
  if (draftCount && draftCount.n > 0) {
    await env.NOTIFY.send({
      to: env.NOTIFY_TO,
      from: env.NOTIFY_FROM,
      subject: `Invoice Rescue: ${draftCount.n} chase draft(s) ready for review`,
      text: `${draftCount.n} chase message(s) are waiting for your review at /admin.`,
    });
  }
}

interface ClientRow {
  id: number;
  company_name: string;
  contact_email: string;
}
interface InvoiceSummaryRow {
  invoice_number: string;
  amount_pence: number;
}

/** Cron: Friday cash report per active client. */
async function runFridayReport(env: Env): Promise<void> {
  const clients = await env.DB.prepare(`SELECT id, company_name, contact_email FROM clients WHERE status = 'active'`)
    .all<ClientRow>();

  for (const client of clients.results ?? []) {
    const paid = await env.DB.prepare(
      `SELECT invoice_number, amount_pence FROM invoices WHERE client_id = ?1 AND status = 'paid' AND paid_date >= date('now', '-7 days')`,
    )
      .bind(client.id)
      .all<InvoiceSummaryRow>();
    const promised = await env.DB.prepare(
      `SELECT invoice_number, amount_pence FROM invoices WHERE client_id = ?1 AND status = 'promised'`,
    )
      .bind(client.id)
      .all<InvoiceSummaryRow>();
    const escalating = await env.DB.prepare(
      `SELECT invoice_number, amount_pence FROM invoices WHERE client_id = ?1 AND status IN ('overdue', 'escalated')`,
    )
      .bind(client.id)
      .all<InvoiceSummaryRow>();

    const section = (label: string, rows: InvoiceSummaryRow[]) =>
      rows.length === 0
        ? `${label}: none`
        : `${label}:\n` + rows.map((r) => `  ${r.invoice_number} — £${(r.amount_pence / 100).toFixed(2)}`).join("\n");

    await env.SEND.send({
      to: client.contact_email,
      from: env.NOTIFY_FROM,
      subject: "Invoice Rescue — your Friday cash report",
      text: [
        `Hi ${client.company_name},`,
        "",
        section("Paid this week", paid.results ?? []),
        "",
        section("Promised", promised.results ?? []),
        "",
        section("Still escalating", escalating.results ?? []),
      ].join("\n"),
    });
  }
}
