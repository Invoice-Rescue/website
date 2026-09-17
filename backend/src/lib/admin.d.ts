export interface DraftRow {
    id: number;
    step: number;
    body: string | null;
    subject: string | null;
    invoice_number: string;
    debtor_name: string;
    debtor_email: string | null;
    company_name: string;
}
/** Server-rendered review queue — no build step, consistent with the rest of this repo. */
export declare function renderReviewQueue(drafts: DraftRow[]): string;
export declare function escapeHtml(s: string): string;
