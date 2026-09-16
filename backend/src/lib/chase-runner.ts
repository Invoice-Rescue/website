import { CADENCE_DAYS, STEP_LABELS, diffDays } from "./escalation";
export { diffDays };
import { fixedCompensationPence, statutoryInterestPence } from "./statutory-interest";
import { buildChasePrompt, draftChaseMessage } from "./gemini";
import { sendOperatorNotification } from "./email";

export const SENDER_NAME = "Invoice Rescue";

export interface OverdueInvoiceRow {
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

export interface ChaseRunResult {
  draftsCreated: number;
  invoicesEscalated: number;
  skippedDrafts: number;
  errors: string[];
}

export function parseDate(dateVal: string | Date | number): Date {
  if (dateVal instanceof Date) return dateVal;
  if (typeof dateVal === "number") return new Date(dateVal);
  const trimmed = String(dateVal).trim();
  if (trimmed.includes("T")) {
    return new Date(trimmed.endsWith("Z") ? trimmed : trimmed + "Z");
  }
  if (trimmed.includes(" ")) {
    return new Date(trimmed.replace(" ", "T") + "Z");
  }
  return new Date(trimmed + "T00:00:00Z");
}

export function generateFallbackDraft(
  inv: OverdueInvoiceRow,
  step: number,
  interestPence: number,
  compPence: number,
): string {
  const amountStr = `${inv.currency} ${(inv.amount_pence / 100).toFixed(2)}`;
  const interestStr = `${inv.currency} ${(interestPence / 100).toFixed(2)}`;
  const compStr = `${inv.currency} ${(compPence / 100).toFixed(2)}`;
  const clientName = inv.company_name;

  let message = "";
  if (step === 1) {
    message = `Hi ${inv.debtor_name},\n\nWe hope this note finds you well. We are following up regarding invoice ${inv.invoice_number} for ${amountStr}, which was due on ${inv.due_date}. We appreciate this may have simply slipped through, so we would be grateful if you could confirm payment at your earliest convenience.`;
  } else if (step === 2) {
    message = `Hi ${inv.debtor_name},\n\nWe are following up on our previous reminder regarding invoice ${inv.invoice_number} for ${amountStr}, due on ${inv.due_date} (${inv.days_overdue} days overdue). Could you please let us know when payment can be expected, or if there are any queries holding it up?`;
  } else if (step === 3) {
    message = `Dear ${inv.debtor_name},\n\nInvoice ${inv.invoice_number} for ${amountStr} remains overdue despite previous reminders. Under the Late Payment of Commercial Debts (Interest) Act 1998, statutory interest of ${interestStr} and statutory compensation of ${compStr} are now due. Please arrange immediate settlement or contact us with a firm payment date.`;
  } else {
    message = `Dear ${inv.debtor_name},\n\nThis is a final notice regarding overdue invoice ${inv.invoice_number} for ${amountStr} (plus statutory interest of ${interestStr} and compensation of ${compStr}). Please note that this is formal 7-day notice before we return this matter to ${clientName} for legal recovery.`;
  }

  const signoff = [
    "",
    "Tibor Rames",
    `Invoice Rescue — acting on behalf of ${clientName}`,
    "hello@invoicerescue.co.uk",
  ].join("\n");

  return `${message}\n${signoff}`;
}

/**
 * Cron: draft the next escalation step for every invoice that's due for one.
 *
 * Enforces:
 * 1. Pending draft gating: skips generating if a draft is already pending review in chase_log.
 * 2. 7-day spacing between successive chases so late-imported invoices do not rapid-fire stages.
 * 3. Locked sender model: passes genuine clientBusinessName (inv.company_name) to buildChasePrompt.
 * 4. Terminal state transition: transitions invoices.status = 'escalated' and notifies operator
 *    when Stage 4 has been sent and 7+ days have elapsed without payment.
 */
export async function runOverdueDetection(env: Env, now?: Date): Promise<ChaseRunResult> {
  const result: ChaseRunResult = {
    draftsCreated: 0,
    invoicesEscalated: 0,
    skippedDrafts: 0,
    errors: [],
  };

  const currentDate = now ?? new Date();

  const query = now
    ? `SELECT i.id, i.client_id, i.debtor_name, i.debtor_email, i.invoice_number, i.amount_pence, i.currency, i.due_date,
              CAST(julianday(?1) - julianday(i.due_date) AS INTEGER) AS days_overdue,
              c.company_name, c.voice_notes
       FROM invoices i JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'overdue' AND i.due_date < date(?1)`
    : `SELECT i.id, i.client_id, i.debtor_name, i.debtor_email, i.invoice_number, i.amount_pence, i.currency, i.due_date,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue,
              c.company_name, c.voice_notes
       FROM invoices i JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'overdue' AND i.due_date < date('now')`;

  const stmt = now
    ? env.DB.prepare(query).bind(now.toISOString())
    : env.DB.prepare(query);

  const overdue = await stmt.all<OverdueInvoiceRow>();
  const boeBaseRatePercent = Number(env.BOE_BASE_RATE_PERCENT);

  for (const inv of overdue.results ?? []) {
    // 1. Pending draft gating: check if invoice already has a row with status = 'draft' in chase_log
    const pendingDraft = await env.DB.prepare(
      `SELECT id FROM chase_log WHERE invoice_id = ?1 AND status = 'draft' LIMIT 1`,
    )
      .bind(inv.id)
      .first<{ id: number }>();

    if (pendingDraft) {
      result.skippedDrafts++;
      continue;
    }

    // 2. Query chase history for this invoice
    const historyRes = await env.DB.prepare(
      `SELECT id, step, channel, status, sent_at, reviewed_at
       FROM chase_log
       WHERE invoice_id = ?1
       ORDER BY step ASC, id ASC`,
    )
      .bind(inv.id)
      .all<{
        id: number;
        step: number;
        channel: string;
        status: string;
        sent_at: string;
        reviewed_at: string | null;
      }>();

    const history = historyRes.results ?? [];

    // Check terminal condition: Has Stage 4 been sent and 7+ days passed without payment?
    const stage4Sent = history.filter((h) => h.step === 4 && h.status === "sent").pop();
    if (stage4Sent) {
      const stage4Date = parseDate(stage4Sent.sent_at);
      const daysSinceStage4 = diffDays(currentDate, stage4Date);
      if (daysSinceStage4 >= 7) {
        // Transition invoice status to 'escalated'
        await env.DB.prepare(`UPDATE invoices SET status = 'escalated' WHERE id = ?1`)
          .bind(inv.id)
          .run();

        // Alert operator via sendOperatorNotification (resilient error boundary)
        await sendOperatorNotification(
          env,
          `Invoice Rescue: Invoice ${inv.invoice_number} escalated (Stage 4 exhausted)`,
          `Invoice ${inv.invoice_number} for ${inv.debtor_name} (${inv.company_name}) has reached terminal escalation after Stage 4 final notice with no payment received. Hand back to client recommended.`,
        );

        result.invoicesEscalated++;
        continue;
      } else {
        // Still within 7-day grace period of Stage 4 final notice; no further draft
        continue;
      }
    }

    // Determine the next step
    const lastStep = history.reduce((max, h) => Math.max(max, h.step), 0);
    const nextStep = lastStep + 1;

    if (nextStep > CADENCE_DAYS.length) {
      // Sequence exhausted (or step > 4)
      continue;
    }

    // Minimum overdue threshold for nextStep
    const minOverdue = CADENCE_DAYS[nextStep - 1];
    if (inv.days_overdue < minOverdue) {
      continue;
    }

    // 3. Enforce 7-day spacing between chases (for steps > 1)
    if (nextStep > 1) {
      // Find the last chase that was sent or reviewed
      const lastChase = history.filter((h) => h.step === lastStep).pop() ?? history[history.length - 1];
      if (lastChase) {
        const lastChaseDate = parseDate(lastChase.sent_at || lastChase.reviewed_at || "");
        const daysSinceChase = diffDays(currentDate, lastChaseDate);
        if (daysSinceChase < 7) {
          // Less than 7 days since prior chase; wait
          continue;
        }
      }
    }

    // 4. Calculate statutory amounts and build prompt
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
      step: nextStep,
      stepLabel: STEP_LABELS[nextStep],
      statutoryInterestPence: interest,
      fixedCompensationPence: compensation,
      clientBusinessName: inv.company_name,
    });

    let body: string;
    try {
      body = await draftChaseMessage(env.GEMINI_API_KEY, prompt);
    } catch (err) {
      console.error(`Gemini draft failed for invoice ${inv.id}:`, err);
      result.errors.push(`Invoice ${inv.id}: ${err instanceof Error ? err.message : String(err)}`);
      body = generateFallbackDraft(inv, nextStep, interest, compensation);
    }

    await env.DB.prepare(
      `INSERT INTO chase_log (invoice_id, step, channel, subject, outcome, status, body)
       VALUES (?1, ?2, 'email', ?3, NULL, 'draft', ?4)`,
    )
      .bind(inv.id, nextStep, `Re: Invoice ${inv.invoice_number}`, body)
      .run();

    result.draftsCreated++;
  }

  // Notify operator if any drafts are waiting for review
  const draftCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chase_log WHERE status = 'draft'`,
  ).first<{ n: number }>();

  if (draftCount && draftCount.n > 0) {
    await sendOperatorNotification(
      env,
      `Invoice Rescue: ${draftCount.n} chase draft(s) ready for review`,
      `${draftCount.n} chase message(s) are waiting for your review at /admin.`,
    );
  }

  return result;
}
