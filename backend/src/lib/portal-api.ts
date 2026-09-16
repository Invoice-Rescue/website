/**
 * Invoice Rescue — Client Portal & Review Queue API (Milestone M3 / R3)
 *
 * Implements the 6 core portal and review queue endpoints:
 * 1. handlePortalDashboardData: Executive overview metrics, 4-tier aging breakdown, pipeline, recent activity
 * 2. handlePortalDebtors: Debtor ledger with debounced search, stage/status filtering, and multi-column sorting
 * 3. handleGetDrafts: Review queue listing with full statutory claim calculation breakdown
 * 4. handleApproveDraft: Approves draft, dispatches email via env.SEND locked to hello@invoicerescue.co.uk
 * 5. handleSkipDraft: Skips/defers draft with zero emails sent
 * 6. handleUpdateDraft: In-place message edit saving in chase_log
 *
 * Enforces strict tenant isolation, locked sender model, and zero external runtime dependencies.
 */

import { fixedCompensationPence, statutoryInterestPence } from "./statutory-interest";
import { diffDays } from "./escalation";
import { verifySessionToken } from "./portal-auth";
import { sendDebtorCommunication } from "./email";

export const SENDER_NAME = "Invoice Rescue";
export const LOCKED_SENDER_EMAIL = "hello@invoicerescue.co.uk";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export interface AuthContext {
  isAdmin: boolean;
  clientId: number | null; // null for unrestricted admin without explicit client_id
}

/**
 * Resolves request authentication:
 * 1. Admin Basic Auth (Authorization: Basic <base64>)
 * 2. Client Session (Authorization: Bearer <token> or portal_session cookie)
 * 3. Returns { auth, errorResponse }
 */
export async function resolveAuth(
  request: Request,
  env: Env,
): Promise<{ auth: AuthContext | null; errorResponse: Response | null }> {
  const authHeader = request.headers.get("Authorization");

  // 1. Check HTTP Basic Auth (Admin)
  if (authHeader?.startsWith("Basic ")) {
    const match = authHeader.match(/^Basic (.+)$/);
    const password = match ? atob(match[1]).slice(atob(match[1]).indexOf(":") + 1) : null;
    if (password === env.ADMIN_SECRET) {
      const url = new URL(request.url);
      const queryCid = url.searchParams.get("client_id");
      return {
        auth: {
          isAdmin: true,
          clientId: queryCid ? Number(queryCid) : null,
        },
        errorResponse: null,
      };
    }
    return {
      auth: null,
      errorResponse: new Response("Unauthorized", {
        status: 401,
        headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
      }),
    };
  }

  // 2. Check Bearer Token (Client Portal)
  let token: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    // Check Cookie header: portal_session or ir_portal_session
    const cookieHeader = request.headers.get("Cookie") ?? "";
    const match = cookieHeader.match(/(?:^|;\s*)(?:portal_session|ir_portal_session)=([^;]+)/);
    if (match) token = match[1];
  }

  if (token) {
    const cid = await verifySessionToken(token, env.PORTAL_SESSION_SECRET);
    if (cid !== null) {
      return {
        auth: {
          isAdmin: false,
          clientId: cid,
        },
        errorResponse: null,
      };
    }
  }

  return { auth: null, errorResponse: null };
}

/**
 * Resolves the target clientId for client portal requests:
 * - If client session: strictly enforces session clientId. Rejects mismatching ?client_id with 403.
 * - If admin: uses ?client_id if provided.
 * - If unauthenticated (demo mode): falls back to the first active client.
 */
export async function resolvePortalClientId(
  request: Request,
  env: Env,
): Promise<{ clientId: number | null; errorResponse: Response | null }> {
  const { auth, errorResponse } = await resolveAuth(request, env);
  if (errorResponse) {
    return { clientId: null, errorResponse };
  }

  const url = new URL(request.url);
  const queryCid = url.searchParams.get("client_id");

  if (auth) {
    if (auth.isAdmin) {
      if (queryCid) return { clientId: Number(queryCid), errorResponse: null };
    } else {
      // Authenticated client: strictly isolate tenant
      if (queryCid && Number(queryCid) !== auth.clientId) {
        return {
          clientId: null,
          errorResponse: Response.json(
            { ok: false, error: "Forbidden: Cannot access another client's data." },
            { status: 403, headers: SECURITY_HEADERS },
          ),
        };
      }
      return { clientId: auth.clientId, errorResponse: null };
    }
  }

  // Fallback for admin without client_id or demo unauthenticated mode
  const activeClient = await env.DB.prepare(
    `SELECT id FROM clients WHERE status = 'active' ORDER BY id ASC LIMIT 1`,
  ).first<{ id: number }>();

  if (activeClient) {
    return { clientId: activeClient.id, errorResponse: null };
  }

  const firstClient = await env.DB.prepare(
    `SELECT id FROM clients ORDER BY id ASC LIMIT 1`,
  ).first<{ id: number }>();

  return { clientId: firstClient ? firstClient.id : null, errorResponse: null };
}

/**
 * Calculates days overdue between invoice due_date and current timestamp.
 */
export function calculateDaysOverdue(dueDateStr: string): number {
  if (!dueDateStr) return 0;
  const due = new Date(dueDateStr);
  if (isNaN(due.getTime())) return 0;
  const now = new Date();
  return Math.max(0, diffDays(now, due));
}

/**
 * Derives escalation stage (0 to 4) and human-readable label.
 */
export function deriveStage(daysOverdue: number, maxStepFromChaseLog?: number | null): { stage: number; label: string } {
  const stage = maxStepFromChaseLog && maxStepFromChaseLog > 0
    ? maxStepFromChaseLog
    : daysOverdue < 1
    ? 0
    : daysOverdue <= 7
    ? 1
    : daysOverdue <= 14
    ? 2
    : daysOverdue <= 21
    ? 3
    : 4;

  const label =
    stage === 0
      ? "Current"
      : stage === 1
      ? "Stage 1 (Gentle)"
      : stage === 2
      ? "Stage 2 (Follow-up)"
      : stage === 3
      ? "Stage 3 (Firm)"
      : "Stage 4 (Final)";

  return { stage, label };
}

/**
 * Formats a monetary amount in major currency units.
 */
export function formatMoney(amountPence: number, currency: string = "GBP"): string {
  const sym = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  return `${sym}${(amountPence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ============================================================================
// 1. GET /api/portal/dashboard-data
// ============================================================================
export async function handlePortalDashboardData(request: Request, env: Env): Promise<Response> {
  const { clientId, errorResponse } = await resolvePortalClientId(request, env);
  if (errorResponse) return errorResponse;

  if (clientId === null) {
    // Empty database fallback
    return Response.json(
      {
        ok: true,
        clientId: null,
        companyName: "Demo Client",
        plan: "foundation",
        metrics: {
          totalOverduePence: 0,
          activeChasingPence: 0,
          recoveredMonthPence: 0,
          overdueCount: 0,
        },
        overdueTotals: {
          totalOverduePence: 0,
          activeChasingPence: 0,
          recoveredMonthPence: 0,
          overdueCount: 0,
        },
        agingBreakdown: {
          bucket1_to_7: { amountPence: 0, count: 0, percentage: 0, days: "1-7d", stage: 1 },
          bucket8_to_14: { amountPence: 0, count: 0, percentage: 0, days: "8-14d", stage: 2 },
          bucket15_to_21: { amountPence: 0, count: 0, percentage: 0, days: "15-21d", stage: 3 },
          bucket22_plus: { amountPence: 0, count: 0, percentage: 0, days: "22d+", stage: 4 },
          bucket1: { amountPence: 0, count: 0, percentage: 0, days: "1-7d", stage: 1 },
          bucket2: { amountPence: 0, count: 0, percentage: 0, days: "8-14d", stage: 2 },
          bucket3: { amountPence: 0, count: 0, percentage: 0, days: "15-21d", stage: 3 },
          bucket4: { amountPence: 0, count: 0, percentage: 0, days: "22d+", stage: 4 },
        },
        pipeline: { count: 0, amountPence: 0 },
        recentActivity: [],
      },
      { headers: SECURITY_HEADERS },
    );
  }

  const client = await env.DB.prepare(
    `SELECT id, company_name, plan FROM clients WHERE id = ?1`,
  ).bind(clientId).first<{ id: number; company_name: string; plan: string }>();

  const invoices = await env.DB.prepare(
    `SELECT id, amount_pence, currency, due_date, status, paid_date
     FROM invoices
     WHERE client_id = ?1`,
  ).bind(clientId).all<{
    id: number;
    amount_pence: number;
    currency: string;
    due_date: string;
    status: string;
    paid_date: string | null;
  }>();

  let totalOverduePence = 0;
  let activeChasingPence = 0;
  let recoveredMonthPence = 0;
  let overdueCount = 0;

  let b1Pence = 0, b1Count = 0;
  let b2Pence = 0, b2Count = 0;
  let b3Pence = 0, b3Count = 0;
  let b4Pence = 0, b4Count = 0;

  const nowMs = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  for (const inv of invoices.results ?? []) {
    if (inv.status === "paid") {
      const isRecent = !inv.paid_date || (nowMs - new Date(inv.paid_date).getTime() <= thirtyDaysMs);
      if (isRecent) {
        recoveredMonthPence += inv.amount_pence;
      }
    } else if (["overdue", "promised", "disputed", "escalated"].includes(inv.status)) {
      totalOverduePence += inv.amount_pence;
      overdueCount++;

      if (inv.status !== "disputed") {
        activeChasingPence += inv.amount_pence;
      }

      const days = calculateDaysOverdue(inv.due_date);
      if (days <= 7) {
        b1Pence += inv.amount_pence;
        b1Count++;
      } else if (days <= 14) {
        b2Pence += inv.amount_pence;
        b2Count++;
      } else if (days <= 21) {
        b3Pence += inv.amount_pence;
        b3Count++;
      } else {
        b4Pence += inv.amount_pence;
        b4Count++;
      }
    }
  }

  const sumAging = b1Pence + b2Pence + b3Pence + b4Pence;
  const p1 = sumAging > 0 ? Math.round((b1Pence / sumAging) * 100) : 0;
  const p2 = sumAging > 0 ? Math.round((b2Pence / sumAging) * 100) : 0;
  const p3 = sumAging > 0 ? Math.round((b3Pence / sumAging) * 100) : 0;
  const p4 = sumAging > 0 ? Math.max(0, 100 - (p1 + p2 + p3)) : 0;

  // Recent activity feed from chase_log
  const activityRows = await env.DB.prepare(
    `SELECT cl.id, cl.step, cl.channel, cl.subject, cl.status, cl.sent_at, cl.reviewed_at,
            i.invoice_number, i.debtor_name, i.amount_pence, i.currency
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     WHERE i.client_id = ?1
     ORDER BY COALESCE(cl.reviewed_at, cl.sent_at) DESC
     LIMIT 10`,
  ).bind(clientId).all<{
    id: number;
    step: number;
    channel: string;
    subject: string | null;
    status: string;
    sent_at: string;
    reviewed_at: string | null;
    invoice_number: string;
    debtor_name: string;
    amount_pence: number;
    currency: string;
  }>();

  const recentActivity = (activityRows.results ?? []).map((row) => {
    const isSent = row.status === "sent";
    const isDraft = row.status === "draft";
    return {
      id: `chase_${row.id}`,
      type: isSent ? "sent" : isDraft ? "draft" : "skipped",
      title: isSent ? `Stage ${row.step} dispatched` : isDraft ? `Stage ${row.step} staged` : `Stage ${row.step} skipped`,
      detail: `${row.invoice_number} (${row.debtor_name})`,
      amountPence: row.amount_pence,
      amount: formatMoney(row.amount_pence, row.currency),
      currency: row.currency || "GBP",
      timestamp: row.reviewed_at || row.sent_at,
      time: row.reviewed_at || row.sent_at,
    };
  });

  return Response.json(
    {
      ok: true,
      clientId,
      companyName: client?.company_name ?? "Client",
      plan: client?.plan ?? "engine",
      metrics: {
        totalOverduePence,
        activeChasingPence,
        recoveredMonthPence,
        overdueCount,
      },
      overdueTotals: {
        totalOverduePence,
        activeChasingPence,
        recoveredMonthPence,
        overdueCount,
      },
      agingBreakdown: {
        bucket1_to_7: { amountPence: b1Pence, count: b1Count, percentage: p1, days: "1-7d", stage: 1 },
        bucket8_to_14: { amountPence: b2Pence, count: b2Count, percentage: p2, days: "8-14d", stage: 2 },
        bucket15_to_21: { amountPence: b3Pence, count: b3Count, percentage: p3, days: "15-21d", stage: 3 },
        bucket22_plus: { amountPence: b4Pence, count: b4Count, percentage: p4, days: "22d+", stage: 4 },
        bucket1: { amountPence: b1Pence, count: b1Count, percentage: p1, days: "1-7d", stage: 1 },
        bucket2: { amountPence: b2Pence, count: b2Count, percentage: p2, days: "8-14d", stage: 2 },
        bucket3: { amountPence: b3Pence, count: b3Count, percentage: p3, days: "15-21d", stage: 3 },
        bucket4: { amountPence: b4Pence, count: b4Count, percentage: p4, days: "22d+", stage: 4 },
      },
      pipeline: {
        count: overdueCount,
        amountPence: activeChasingPence,
      },
      recentActivity,
    },
    { headers: SECURITY_HEADERS },
  );
}

// ============================================================================
// 2. GET /api/portal/debtors
// ============================================================================
export async function handlePortalDebtors(request: Request, env: Env): Promise<Response> {
  const { clientId, errorResponse } = await resolvePortalClientId(request, env);
  if (errorResponse) return errorResponse;

  if (clientId === null) {
    return Response.json(
      { ok: true, clientId: null, debtors: [], total: 0, page: 1, limit: 50, totalPages: 1 },
      { headers: SECURITY_HEADERS },
    );
  }

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || url.searchParams.get("q") || "").trim().toLowerCase();
  const stageFilter = (url.searchParams.get("stage") || "all").toLowerCase();
  const statusFilter = (url.searchParams.get("status") || "all").toLowerCase();
  const sortCol = (url.searchParams.get("sort") || "days_overdue").toLowerCase();
  const sortDir = (url.searchParams.get("dir") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));

  const rows = await env.DB.prepare(
    `SELECT
       i.id,
       i.client_id,
       i.debtor_name,
       i.debtor_email,
       i.invoice_number,
       i.amount_pence,
       i.currency,
       i.due_date,
       i.issued_date,
       i.status,
       i.paid_date,
       (SELECT MAX(cl.step) FROM chase_log cl WHERE cl.invoice_id = i.id) AS max_chase_step,
       (SELECT cl.sent_at FROM chase_log cl WHERE cl.invoice_id = i.id AND cl.status = 'sent' ORDER BY cl.sent_at DESC LIMIT 1) AS last_contact_at
     FROM invoices i
     WHERE i.client_id = ?1`,
  ).bind(clientId).all<{
    id: number;
    client_id: number;
    debtor_name: string;
    debtor_email: string | null;
    invoice_number: string;
    amount_pence: number;
    currency: string;
    due_date: string;
    issued_date: string | null;
    status: string;
    paid_date: string | null;
    max_chase_step: number | null;
    last_contact_at: string | null;
  }>();

  let debtors = (rows.results ?? []).map((row) => {
    const daysOverdue = calculateDaysOverdue(row.due_date);
    const { stage, label } = deriveStage(daysOverdue, row.max_chase_step);

    let lastContact = "No contact yet";
    if (row.status === "paid") {
      lastContact = "Settled in full";
    } else if (row.last_contact_at) {
      lastContact = row.last_contact_at;
    }

    return {
      id: row.id,
      invoice_number: row.invoice_number,
      debtor_name: row.debtor_name,
      debtor_email: row.debtor_email,
      amount_pence: row.amount_pence,
      currency: row.currency || "GBP",
      due_date: row.due_date,
      issued_date: row.issued_date,
      days_overdue: daysOverdue,
      stage,
      stage_label: label,
      status: row.status,
      last_contact: lastContact,
    };
  });

  // 1. Search Filter (Debtor Name, Invoice Number, Email)
  if (search) {
    debtors = debtors.filter(
      (d) =>
        d.debtor_name.toLowerCase().includes(search) ||
        d.invoice_number.toLowerCase().includes(search) ||
        (d.debtor_email && d.debtor_email.toLowerCase().includes(search)),
    );
  }

  // 2. Stage Filter
  if (stageFilter !== "all") {
    let targetStage: number | null = null;
    if (stageFilter === "1" || stageFilter === "stage_1") targetStage = 1;
    else if (stageFilter === "2" || stageFilter === "stage_2") targetStage = 2;
    else if (stageFilter === "3" || stageFilter === "stage_3") targetStage = 3;
    else if (stageFilter === "4" || stageFilter === "stage_4") targetStage = 4;
    else if (stageFilter === "0" || stageFilter === "current") targetStage = 0;

    if (targetStage !== null) {
      debtors = debtors.filter((d) => d.stage === targetStage);
    }
  }

  // 3. Status Filter
  if (statusFilter !== "all") {
    debtors = debtors.filter((d) => d.status.toLowerCase() === statusFilter);
  }

  // 4. Sorting
  debtors.sort((a, b) => {
    let valA: string | number = a.days_overdue;
    let valB: string | number = b.days_overdue;

    if (sortCol === "amount" || sortCol === "amount_pence") {
      valA = a.amount_pence;
      valB = b.amount_pence;
    } else if (sortCol === "due_date") {
      valA = a.due_date;
      valB = b.due_date;
    } else if (sortCol === "debtor_name") {
      valA = a.debtor_name.toLowerCase();
      valB = b.debtor_name.toLowerCase();
    } else if (sortCol === "invoice_number") {
      valA = a.invoice_number.toLowerCase();
      valB = b.invoice_number.toLowerCase();
    } else if (sortCol === "status") {
      valA = a.status.toLowerCase();
      valB = b.status.toLowerCase();
    } else if (sortCol === "stage") {
      valA = a.stage;
      valB = b.stage;
    }

    if (valA < valB) return sortDir === "asc" ? -1 : 1;
    if (valA > valB) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const total = debtors.length;
  const offset = (page - 1) * limit;
  const paginated = debtors.slice(offset, offset + limit);

  return Response.json(
    {
      ok: true,
      clientId,
      debtors: paginated,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    { headers: SECURITY_HEADERS },
  );
}

// ============================================================================
// 3. GET /api/admin/drafts & GET /api/chase/queue
// ============================================================================
export async function handleGetDrafts(request: Request, env: Env): Promise<Response> {
  const { auth, errorResponse } = await resolveAuth(request, env);
  if (errorResponse) return errorResponse;
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
    });
  }

  const boeBaseRate = Number(env.BOE_BASE_RATE_PERCENT || "3.75");
  const queryParamCid = new URL(request.url).searchParams.get("client_id");

  // Determine clientId scope:
  // If client session, lock to auth.clientId. If admin, optionally filter by queryParamCid.
  const targetCid = !auth.isAdmin ? auth.clientId : queryParamCid ? Number(queryParamCid) : null;

  let sql = `
    SELECT
      cl.id,
      cl.invoice_id,
      cl.step,
      cl.channel,
      cl.subject,
      cl.body,
      cl.status,
      cl.sent_at,
      i.invoice_number,
      i.debtor_name,
      i.debtor_email,
      i.amount_pence,
      i.currency,
      i.due_date,
      c.id AS client_id,
      c.company_name
    FROM chase_log cl
    JOIN invoices i ON i.id = cl.invoice_id
    JOIN clients c ON c.id = i.client_id
    WHERE cl.status = 'draft'
  `;

  if (targetCid !== null) {
    sql += ` AND c.id = ?1`;
  }
  sql += ` ORDER BY cl.sent_at ASC`;

  const stmt = targetCid !== null ? env.DB.prepare(sql).bind(targetCid) : env.DB.prepare(sql);
  const rows = await stmt.all<{
    id: number;
    invoice_id: number;
    step: number;
    channel: string;
    subject: string | null;
    body: string | null;
    status: string;
    sent_at: string;
    invoice_number: string;
    debtor_name: string;
    debtor_email: string | null;
    amount_pence: number;
    currency: string;
    due_date: string;
    client_id: number;
    company_name: string;
  }>();

  const drafts = (rows.results ?? []).map((row) => {
    const daysOverdue = calculateDaysOverdue(row.due_date);
    const compensationPence = fixedCompensationPence(row.amount_pence);
    const interestPence = daysOverdue <= 0 ? 0 : statutoryInterestPence(row.amount_pence, daysOverdue, boeBaseRate);
    const totalClaimPence = row.amount_pence + compensationPence + interestPence;

    const stepLabel =
      row.step === 1
        ? "Stage 1 (Gentle)"
        : row.step === 2
        ? "Stage 2 (Follow-up)"
        : row.step === 3
        ? "Stage 3 (Firm Notice)"
        : "Stage 4 (Final Notice)";

    return {
      id: row.id,
      invoice_id: row.invoice_id,
      invoice_number: row.invoice_number,
      debtor_name: row.debtor_name,
      debtor_email: row.debtor_email,
      client_id: row.client_id,
      company_name: row.company_name,
      currency: row.currency || "GBP",
      due_date: row.due_date,
      days_overdue: daysOverdue,
      step: row.step,
      step_label: stepLabel,
      subject: row.subject,
      body: row.body ?? "",
      locked_sender: env.NOTIFY_FROM || LOCKED_SENDER_EMAIL,
      amount_pence: row.amount_pence,
      principal_pence: row.amount_pence,
      fixed_compensation_pence: compensationPence,
      statutory_interest_pence: interestPence,
      total_claim_pence: totalClaimPence,
      boe_base_rate_percent: boeBaseRate,
    };
  });

  return Response.json({ ok: true, drafts, count: drafts.length }, { headers: SECURITY_HEADERS });
}

// ============================================================================
// 4. POST /api/admin/drafts/:id/approve & POST /api/chase/:id/approve
// ============================================================================
export async function handleApproveDraft(
  request: Request,
  env: Env,
  draftIdParam: string,
): Promise<Response> {
  const { auth, errorResponse } = await resolveAuth(request, env);
  if (errorResponse) return errorResponse;
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
    });
  }

  const draftId = Number(draftIdParam);
  if (isNaN(draftId) || draftId <= 0) {
    return Response.json({ ok: false, error: "Invalid draft ID." }, { status: 400, headers: SECURITY_HEADERS });
  }

  const row = await env.DB.prepare(
    `SELECT cl.id, cl.body, cl.subject, cl.status, cl.step, cl.invoice_id,
            i.debtor_email, i.debtor_name, i.invoice_number, i.client_id,
            c.company_name
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     JOIN clients c ON c.id = i.client_id
     WHERE cl.id = ?1`,
  ).bind(draftId).first<{
    id: number;
    body: string | null;
    subject: string | null;
    status: string;
    step: number;
    invoice_id: number;
    debtor_email: string | null;
    debtor_name: string;
    invoice_number: string;
    client_id: number;
    company_name: string;
  }>();

  if (!row || row.status !== "draft") {
    return Response.json(
      { ok: false, error: "Draft not found or already reviewed." },
      { status: 404, headers: SECURITY_HEADERS },
    );
  }

  // Tenant Boundary Check: Client sessions cannot approve another tenant's draft
  if (!auth.isAdmin && auth.clientId !== row.client_id) {
    return Response.json(
      { ok: false, error: "Forbidden: Cannot approve draft for another client." },
      { status: 403, headers: SECURITY_HEADERS },
    );
  }

  if (!row.debtor_email) {
    return Response.json(
      { ok: false, error: "Invoice has no debtor email on file." },
      { status: 422, headers: SECURITY_HEADERS },
    );
  }

  // Extract optional edited message body (supports both JSON and form URL-encoded)
  let body = row.body ?? "";
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const json = await request.json() as Record<string, unknown>;
      const edited = (json.body ?? json.custom_message) as string | undefined;
      if (typeof edited === "string" && edited.trim()) {
        body = edited;
      }
    } catch {
      // Ignore unparseable JSON and keep current body
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await request.formData();
      const edited = form.get("body") ?? form.get("custom_message");
      if (typeof edited === "string" && edited.trim()) {
        body = edited;
      }
    } catch {
      // Keep current body
    }
  }

  // Dispatch outbound debtor email locked to hello@invoicerescue.co.uk
  const sent = await sendDebtorCommunication(
    env,
    row.debtor_email,
    row.subject ?? `Re: Invoice ${row.invoice_number}`,
    body,
  );

  if (!sent) {
    return Response.json(
      { ok: false, error: "Failed to dispatch email communication to debtor." },
      { status: 500, headers: SECURITY_HEADERS },
    );
  }

  const reviewerName = env.OPERATOR_NAME || "Tibor Rames";

  await env.DB.prepare(
    `UPDATE chase_log
     SET status = 'sent',
         body = ?2,
         outcome = 'sent',
         sent_at = datetime('now'),
         reviewed_at = datetime('now'),
         reviewed_by = ?3
     WHERE id = ?1 AND status = 'draft'`,
  ).bind(draftId, body, reviewerName).run();

  const accepts = request.headers.get("Accept") ?? "";
  if (accepts.includes("application/json")) {
    return Response.json(
      {
        ok: true,
        draft_id: draftId,
        status: "sent",
        recipient: row.debtor_email,
        sent_at: new Date().toISOString(),
      },
      { headers: SECURITY_HEADERS },
    );
  }

  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/admin" } });
}

// ============================================================================
// 5. POST /api/admin/drafts/:id/skip & POST /api/chase/:id/skip
// ============================================================================
export async function handleSkipDraft(
  request: Request,
  env: Env,
  draftIdParam: string,
): Promise<Response> {
  const { auth, errorResponse } = await resolveAuth(request, env);
  if (errorResponse) return errorResponse;
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
    });
  }

  const draftId = Number(draftIdParam);
  if (isNaN(draftId) || draftId <= 0) {
    return Response.json({ ok: false, error: "Invalid draft ID." }, { status: 400, headers: SECURITY_HEADERS });
  }

  const row = await env.DB.prepare(
    `SELECT cl.id, cl.status, i.client_id
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     WHERE cl.id = ?1`,
  ).bind(draftId).first<{ id: number; status: string; client_id: number }>();

  if (!row) {
    return Response.json({ ok: false, error: "Draft not found." }, { status: 404, headers: SECURITY_HEADERS });
  }

  if (!auth.isAdmin && auth.clientId !== row.client_id) {
    return Response.json(
      { ok: false, error: "Forbidden: Cannot skip draft for another client." },
      { status: 403, headers: SECURITY_HEADERS },
    );
  }

  if (row.status === "draft") {
    const reviewerName = env.OPERATOR_NAME || "Tibor Rames";
    await env.DB.prepare(
      `UPDATE chase_log
       SET status = 'skipped',
           reviewed_at = datetime('now'),
           reviewed_by = ?2
       WHERE id = ?1 AND status = 'draft'`,
    ).bind(draftId, reviewerName).run();
  }

  const accepts = request.headers.get("Accept") ?? "";
  if (accepts.includes("application/json")) {
    return Response.json(
      { ok: true, draft_id: draftId, status: "skipped" },
      { headers: SECURITY_HEADERS },
    );
  }

  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: "/admin" } });
}

// ============================================================================
// 6. PUT /api/admin/drafts/:id & PUT /api/chase/:id
// ============================================================================
export async function handleUpdateDraft(
  request: Request,
  env: Env,
  draftIdParam: string,
): Promise<Response> {
  const { auth, errorResponse } = await resolveAuth(request, env);
  if (errorResponse) return errorResponse;
  if (!auth) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Invoice Rescue admin"' },
    });
  }

  const draftId = Number(draftIdParam);
  if (isNaN(draftId) || draftId <= 0) {
    return Response.json({ ok: false, error: "Invalid draft ID." }, { status: 400, headers: SECURITY_HEADERS });
  }

  let body: string | null = null;
  let subject: string | null = null;

  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await request.json() as Record<string, unknown>;
      if (typeof json.body === "string") body = json.body;
      else if (typeof json.custom_message === "string") body = json.custom_message;
      if (typeof json.subject === "string") subject = json.subject;
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400, headers: SECURITY_HEADERS });
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await request.formData();
      const b = form.get("body") ?? form.get("custom_message");
      if (typeof b === "string") body = b;
      const s = form.get("subject");
      if (typeof s === "string") subject = s;
    } catch {
      return Response.json({ ok: false, error: "Invalid form body." }, { status: 400, headers: SECURITY_HEADERS });
    }
  } else {
    try {
      const rawText = await request.text();
      if (rawText.trim()) body = rawText;
    } catch {
      // empty
    }
  }

  if (body === null || !body.trim()) {
    return Response.json(
      { ok: false, error: "Draft body cannot be empty." },
      { status: 400, headers: SECURITY_HEADERS },
    );
  }

  const row = await env.DB.prepare(
    `SELECT cl.id, cl.status, cl.subject, i.client_id
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     WHERE cl.id = ?1`,
  ).bind(draftId).first<{ id: number; status: string; subject: string | null; client_id: number }>();

  if (!row || row.status !== "draft") {
    return Response.json(
      { ok: false, error: "Draft not found or already reviewed." },
      { status: 404, headers: SECURITY_HEADERS },
    );
  }

  if (!auth.isAdmin && auth.clientId !== row.client_id) {
    return Response.json(
      { ok: false, error: "Forbidden: Cannot edit draft for another client." },
      { status: 403, headers: SECURITY_HEADERS },
    );
  }

  const updatedSubject = subject ?? row.subject;

  await env.DB.prepare(
    `UPDATE chase_log
     SET body = ?2,
         subject = COALESCE(?3, subject)
     WHERE id = ?1 AND status = 'draft'`,
  ).bind(draftId, body, updatedSubject).run();

  return Response.json(
    {
      ok: true,
      draft_id: draftId,
      body,
      subject: updatedSubject,
    },
    { headers: SECURITY_HEADERS },
  );
}
