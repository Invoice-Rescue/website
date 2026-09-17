/**
 * Tenant-isolated data repository layer for Invoice Rescue.
 * Guarantees strict client_id scoping, atomic upserts, and zero cross-tenant data leakage.
 */
export type InvoiceStatus = 'overdue' | 'promised' | 'disputed' | 'paid' | 'escalated';
export type AccountingProvider = 'xero' | 'quickbooks';
export type ConnectionStatus = 'active' | 'expired' | 'revoked';
export interface TenantInvoice {
    id: number;
    clientId: number;
    debtorName: string;
    debtorEmail: string | null;
    invoiceNumber: string;
    amountPence: number;
    currency: string;
    issuedDate: string | null;
    dueDate: string;
    status: InvoiceStatus;
    paidDate: string | null;
    createdAt: string;
    externalId: string | null;
    lastSyncedAt: string | null;
}
export type Invoice = TenantInvoice;
export interface UpsertInvoiceInput {
    debtorName: string;
    debtorEmail?: string | null;
    invoiceNumber: string;
    amountPence: number;
    currency?: string;
    issuedDate?: string | null;
    dueDate: string;
    status?: InvoiceStatus;
    externalId?: string | null;
    paidDate?: string | null;
}
export type InvoiceInput = UpsertInvoiceInput;
export interface UpsertInvoiceResult {
    action: 'inserted' | 'updated';
    invoiceNumber: string;
}
export interface TenantChaseDraft {
    id: number;
    invoiceId: number;
    step: number;
    channel: string;
    subject: string | null;
    body: string | null;
    status: 'draft' | 'sent' | 'skipped';
    sentAt: string;
    reviewedAt: string | null;
    reviewedBy: string | null;
    invoiceNumber: string;
    debtorName: string;
    debtorEmail: string | null;
    amountPence: number;
}
export interface TenantAccountingConnection {
    id: number;
    clientId: number;
    provider: AccountingProvider;
    tenantId: string | null;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    expiresAt: string;
    lastSyncedAt: string | null;
    status: ConnectionStatus;
    createdAt: string;
}
export declare abstract class TenantRepositoryError extends Error {
    constructor(message: string);
}
export declare class InvalidTenantError extends TenantRepositoryError {
}
export declare class TenantBoundaryViolationError extends TenantRepositoryError {
}
export declare class InvoiceNotFoundError extends TenantRepositoryError {
}
export declare class InvalidInvoiceDataError extends TenantRepositoryError {
}
export declare class InvalidWebhookEventError extends TenantRepositoryError {
}
export declare class InvalidInputError extends TenantRepositoryError {
}
export declare function validateClientId(clientId: unknown): asserts clientId is number;
export declare function validateIntegerId(id: unknown, fieldName: string): asserts id is number;
export declare function validateInvoiceInput(input: UpsertInvoiceInput): void;
/**
 * Retrieves all invoices strictly scoped to clientId.
 */
export declare function getTenantInvoices(db: D1Database, clientId: number): Promise<TenantInvoice[]>;
/**
 * Fetches a single invoice by its tenant-scoped number.
 */
export declare function getTenantInvoiceByNumber(db: D1Database, clientId: number, invoiceNumber: string): Promise<TenantInvoice | null>;
/**
 * Fetches a single invoice by its primary key, strictly validating tenant ownership.
 */
export declare function getTenantInvoiceById(db: D1Database, clientId: number, invoiceId: number): Promise<TenantInvoice | null>;
/**
 * Guarantees atomic, idempotent insert/update respecting UNIQUE (client_id, invoice_number)
 * and protecting settled ('paid') invoices from reverting to overdue.
 */
export declare function upsertTenantInvoice(db: D1Database, clientId: number, invoice: UpsertInvoiceInput): Promise<UpsertInvoiceResult>;
/**
 * Enforces cryptographic webhook idempotency, deduplication, and audit logging.
 * Returns true if new event, false if duplicate.
 */
export declare function recordAccountingWebhook(db: D1Database, eventId: string, provider: AccountingProvider, payload: unknown): Promise<boolean>;
/**
 * Retrieves accounting connection tokens scoped to clientId.
 */
export declare function getAccountingConnection(db: D1Database, clientId: number, provider: AccountingProvider): Promise<TenantAccountingConnection | null>;
/**
 * Atomically connects or rotates tokens for a tenant.
 */
export declare function upsertAccountingConnection(db: D1Database, clientId: number, conn: {
    provider: AccountingProvider;
    tenantId?: string | null;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    expiresAt: string;
    status?: ConnectionStatus;
}): Promise<void>;
/**
 * Resolves external provider tenant ID to internal clientId.
 */
export declare function resolveClientByAccountingTenant(db: D1Database, provider: AccountingProvider, tenantId: string): Promise<number | null>;
/**
 * Chase draft management scoped to tenant.
 */
export declare function getTenantDrafts(db: D1Database, clientId: number): Promise<TenantChaseDraft[]>;
/**
 * Approves a draft scoped strictly to the client's invoices.
 */
export declare function approveTenantDraft(db: D1Database, clientId: number, draftId: number, editedBody: string, reviewedBy: string): Promise<boolean>;
/**
 * Skips a draft scoped strictly to the client's invoices.
 */
export declare function skipTenantDraft(db: D1Database, clientId: number, draftId: number): Promise<boolean>;
export declare class TenantRepository {
    private readonly db;
    readonly clientId: number;
    constructor(db: D1Database, clientId: number);
    getInvoices(): Promise<TenantInvoice[]>;
    getInvoiceByNumber(invoiceNumber: string): Promise<TenantInvoice | null>;
    getInvoiceById(invoiceId: number): Promise<TenantInvoice | null>;
    upsertInvoice(invoice: UpsertInvoiceInput): Promise<UpsertInvoiceResult>;
    getAccountingConnection(provider: AccountingProvider): Promise<TenantAccountingConnection | null>;
    upsertAccountingConnection(conn: {
        provider: AccountingProvider;
        tenantId?: string | null;
        accessTokenEncrypted: string;
        refreshTokenEncrypted: string;
        expiresAt: string;
        status?: ConnectionStatus;
    }): Promise<void>;
    getDrafts(): Promise<TenantChaseDraft[]>;
    approveDraft(draftId: number, editedBody: string, reviewedBy: string): Promise<boolean>;
    skipDraft(draftId: number): Promise<boolean>;
}
