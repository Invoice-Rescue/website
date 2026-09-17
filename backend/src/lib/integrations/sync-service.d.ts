/**
 * Accounting Synchronization Service for Invoice Rescue.
 * Synchronizes invoices from Xero and QuickBooks, reconciles debtor records in D1,
 * enforces multi-tenant isolation, marks settled invoices as 'paid',
 * and halts automated chasing on paid or disputed invoices.
 */
export interface NormalizedInvoice {
    externalId: string;
    invoiceNumber: string;
    debtorName: string;
    debtorEmail: string | null;
    amountPence: number;
    currency: string;
    dueDate: string;
    issuedDate: string | null;
    isPaid: boolean;
    paidDate: string | null;
    isDisputedOrVoid: boolean;
}
export interface SyncResult {
    success: boolean;
    provider?: 'xero' | 'quickbooks';
    clientId: number;
    invoicesSynced: number;
    invoicesCreated: number;
    invoicesUpdated: number;
    invoicesMarkedPaid: number;
    reason?: string;
    errors?: string[];
}
export declare class SyncService {
    private readonly db;
    private readonly env;
    constructor(db: D1Database, env: Env);
    private getEncryptionSecret;
    /**
     * Synchronizes all invoices for a tenant from their active accounting connection.
     */
    syncInvoices(clientId: number): Promise<SyncResult>;
    /**
     * Synchronizes a single invoice by external provider resource ID.
     */
    syncSingleInvoice(clientId: number, provider: 'xero' | 'quickbooks', externalInvoiceId: string): Promise<boolean>;
    /**
     * Disconnects an accounting connection for a tenant and revokes provider tokens with error logging.
     */
    revokeConnection(clientId: number, provider: 'xero' | 'quickbooks'): Promise<boolean>;
    /**
     * Reconciles a normalized invoice into D1 for a given tenant.
     */
    reconcileInvoice(clientId: number, norm: NormalizedInvoice): Promise<'created' | 'updated' | 'marked_paid' | 'unchanged'>;
    /**
     * Resolves token and auto-refreshes if expiring within 5 minutes.
     */
    private resolveFreshAccessToken;
    private fetchXeroInvoices;
    private fetchSingleXeroInvoice;
    private normalizeXeroInvoice;
    private fetchQuickBooksInvoices;
    private fetchSingleQuickBooksInvoice;
    private normalizeQuickBooksInvoice;
}
