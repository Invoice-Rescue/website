import { diffDays } from "./escalation";
export { diffDays };
export declare const SENDER_NAME = "Invoice Rescue";
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
export declare function parseDate(dateVal: string | Date | number): Date;
export declare function generateFallbackDraft(inv: OverdueInvoiceRow, step: number, interestPence: number, compPence: number): string;
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
export declare function runOverdueDetection(env: Env, now?: Date): Promise<ChaseRunResult>;
