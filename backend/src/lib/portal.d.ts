export interface PortalClientRow {
    id: number;
    company_name: string;
    contact_name: string | null;
    stripe_customer_id: string | null;
}
export interface PortalInvoiceRow {
    invoice_number: string;
    debtor_name: string;
    amount_pence: number;
    currency: string;
    status: string;
    due_date: string;
}
export interface PortalChaseRow {
    invoice_number: string;
    step: number;
    status: string;
    sent_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
}
export declare function renderPortalLogin(message?: string): string;
export declare function renderPortalLoginSent(): string;
export declare function renderPortalDashboard(client: PortalClientRow, invoices: PortalInvoiceRow[], chases: PortalChaseRow[]): string;
