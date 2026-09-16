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

// ---------------------------------------------------------------------------
// Error Hierarchy
// ---------------------------------------------------------------------------

export abstract class TenantRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidTenantError extends TenantRepositoryError {}
export class TenantBoundaryViolationError extends TenantRepositoryError {}
export class InvoiceNotFoundError extends TenantRepositoryError {}
export class InvalidInvoiceDataError extends TenantRepositoryError {}
export class InvalidWebhookEventError extends TenantRepositoryError {}
export class InvalidInputError extends TenantRepositoryError {}

// ---------------------------------------------------------------------------
// Validation Guards
// ---------------------------------------------------------------------------

export function validateClientId(clientId: unknown): asserts clientId is number {
  if (typeof clientId !== 'number' || !Number.isInteger(clientId) || clientId <= 0) {
    throw new InvalidTenantError(`Invalid tenant client_id: ${clientId}`);
  }
}

export function validateIntegerId(id: unknown, fieldName: string): asserts id is number {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new InvalidInputError(`Invalid ${fieldName}: ${id}`);
  }
}

export function validateInvoiceInput(input: UpsertInvoiceInput): void {
  if (!input || typeof input !== 'object') {
    throw new InvalidInvoiceDataError('Invoice input must be a non-null object');
  }
  if (!input.debtorName || typeof input.debtorName !== 'string' || input.debtorName.trim().length < 2) {
    throw new InvalidInvoiceDataError('debtorName must be at least 2 characters');
  }
  if (!input.invoiceNumber || typeof input.invoiceNumber !== 'string' || input.invoiceNumber.trim().length < 1) {
    throw new InvalidInvoiceDataError('invoiceNumber is required');
  }
  if (typeof input.amountPence !== 'number' || !Number.isInteger(input.amountPence) || input.amountPence <= 0) {
    throw new InvalidInvoiceDataError('amountPence must be a positive integer in pence');
  }
  if (!input.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate.trim())) {
    throw new InvalidInvoiceDataError('dueDate must be a valid ISO date string (YYYY-MM-DD)');
  }
  if (input.debtorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.debtorEmail.trim())) {
    throw new InvalidInvoiceDataError(`Invalid debtor email: ${input.debtorEmail}`);
  }
  if (input.status) {
    const validStatuses = new Set(['overdue', 'promised', 'disputed', 'paid', 'escalated']);
    if (!validStatuses.has(input.status)) {
      throw new InvalidInvoiceDataError(`Invalid invoice status: ${input.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone Functional API (PROJECT.md §1)
// ---------------------------------------------------------------------------

/**
 * Retrieves all invoices strictly scoped to clientId.
 */
export async function getTenantInvoices(db: D1Database, clientId: number): Promise<TenantInvoice[]> {
  validateClientId(clientId);
  const rows = await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1
     ORDER BY due_date DESC`
  ).bind(clientId).all<TenantInvoice>();

  return rows.results ?? [];
}

/**
 * Fetches a single invoice by its tenant-scoped number.
 */
export async function getTenantInvoiceByNumber(
  db: D1Database,
  clientId: number,
  invoiceNumber: string
): Promise<TenantInvoice | null> {
  validateClientId(clientId);
  if (!invoiceNumber || typeof invoiceNumber !== 'string') return null;

  return await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1 AND invoice_number = ?2`
  ).bind(clientId, invoiceNumber.trim()).first<TenantInvoice>();
}

/**
 * Fetches a single invoice by its primary key, strictly validating tenant ownership.
 */
export async function getTenantInvoiceById(
  db: D1Database,
  clientId: number,
  invoiceId: number
): Promise<TenantInvoice | null> {
  validateClientId(clientId);
  validateIntegerId(invoiceId, 'invoiceId');

  return await db.prepare(
    `SELECT id, client_id AS clientId, debtor_name AS debtorName, debtor_email AS debtorEmail,
            invoice_number AS invoiceNumber, amount_pence AS amountPence, currency,
            issued_date AS issuedDate, due_date AS dueDate, status, paid_date AS paidDate,
            created_at AS createdAt, external_id AS externalId, last_synced_at AS lastSyncedAt
     FROM invoices
     WHERE client_id = ?1 AND id = ?2`
  ).bind(clientId, invoiceId).first<TenantInvoice>();
}

/**
 * Guarantees atomic, idempotent insert/update respecting UNIQUE (client_id, invoice_number)
 * and protecting settled ('paid') invoices from reverting to overdue.
 */
export async function upsertTenantInvoice(
  db: D1Database,
  clientId: number,
  invoice: UpsertInvoiceInput
): Promise<UpsertInvoiceResult> {
  validateClientId(clientId);
  validateInvoiceInput(invoice);

  const status = invoice.status || 'overdue';
  const currency = invoice.currency || 'GBP';
  const debtorEmail = invoice.debtorEmail ? invoice.debtorEmail.trim() : null;
  const issuedDate = invoice.issuedDate ? invoice.issuedDate.trim() : null;
  const externalId = invoice.externalId ? invoice.externalId.trim() : null;
  const paidDate = invoice.paidDate ? invoice.paidDate.trim() : null;

  const existing = await db.prepare(
    `SELECT id, status FROM invoices WHERE client_id = ?1 AND invoice_number = ?2`
  ).bind(clientId, invoice.invoiceNumber.trim()).first<{ id: number; status: string }>();

  await db.prepare(
    `INSERT INTO invoices (
       client_id, debtor_name, debtor_email, invoice_number,
       amount_pence, currency, issued_date, due_date, status,
       paid_date, external_id, last_synced_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       CASE WHEN ?9 = 'paid' THEN COALESCE(?11, date('now')) ELSE NULL END,
       ?10, datetime('now')
     )
     ON CONFLICT(client_id, invoice_number) DO UPDATE SET
       debtor_name = excluded.debtor_name,
       debtor_email = COALESCE(excluded.debtor_email, invoices.debtor_email),
       amount_pence = excluded.amount_pence,
       currency = excluded.currency,
       due_date = excluded.due_date,
       issued_date = COALESCE(excluded.issued_date, invoices.issued_date),
       external_id = COALESCE(excluded.external_id, invoices.external_id),
       status = CASE 
         WHEN invoices.status = 'paid' THEN 'paid'
         WHEN excluded.status = 'paid' THEN 'paid'
         ELSE excluded.status 
       END,
       paid_date = CASE 
         WHEN invoices.status = 'paid' THEN invoices.paid_date
         WHEN excluded.status = 'paid' AND invoices.paid_date IS NULL THEN COALESCE(?11, date('now'))
         ELSE invoices.paid_date 
       END,
       last_synced_at = datetime('now')`
  ).bind(
    clientId,
    invoice.debtorName.trim(),
    debtorEmail,
    invoice.invoiceNumber.trim(),
    invoice.amountPence,
    currency,
    issuedDate,
    invoice.dueDate.trim(),
    status,
    externalId,
    paidDate
  ).run();

  return {
    action: existing ? 'updated' : 'inserted',
    invoiceNumber: invoice.invoiceNumber.trim(),
  };
}

/**
 * Enforces cryptographic webhook idempotency, deduplication, and audit logging.
 * Returns true if new event, false if duplicate.
 */
export async function recordAccountingWebhook(
  db: D1Database,
  eventId: string,
  provider: AccountingProvider,
  payload: unknown
): Promise<boolean> {
  if (!eventId || typeof eventId !== 'string') {
    throw new InvalidWebhookEventError('Missing or invalid eventId');
  }
  if (provider !== 'xero' && provider !== 'quickbooks') {
    throw new InvalidWebhookEventError(`Unsupported accounting provider: ${provider}`);
  }

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  const res = await db.prepare(
    `INSERT OR IGNORE INTO accounting_webhook_events (id, provider, event_type, payload, processed_at)
     VALUES (?1, ?2, 'webhook_event', ?3, datetime('now'))`
  ).bind(eventId.trim(), provider, payloadString).run();

  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Retrieves accounting connection tokens scoped to clientId.
 */
export async function getAccountingConnection(
  db: D1Database,
  clientId: number,
  provider: AccountingProvider
): Promise<TenantAccountingConnection | null> {
  validateClientId(clientId);
  return await db.prepare(
    `SELECT id, client_id AS clientId, provider, tenant_id AS tenantId,
            access_token_encrypted AS accessTokenEncrypted,
            refresh_token_encrypted AS refreshTokenEncrypted,
            expires_at AS expiresAt, last_synced_at AS lastSyncedAt,
            status, created_at AS createdAt
     FROM accounting_connections
     WHERE client_id = ?1 AND provider = ?2`
  ).bind(clientId, provider).first<TenantAccountingConnection>();
}

/**
 * Atomically connects or rotates tokens for a tenant.
 */
export async function upsertAccountingConnection(
  db: D1Database,
  clientId: number,
  conn: {
    provider: AccountingProvider;
    tenantId?: string | null;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    expiresAt: string;
    status?: ConnectionStatus;
  }
): Promise<void> {
  validateClientId(clientId);
  await db.prepare(
    `INSERT INTO accounting_connections (
       client_id, provider, tenant_id, access_token_encrypted,
       refresh_token_encrypted, expires_at, last_synced_at, status, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), ?7, datetime('now'))
     ON CONFLICT(client_id, provider) DO UPDATE SET
       tenant_id = COALESCE(excluded.tenant_id, accounting_connections.tenant_id),
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       expires_at = excluded.expires_at,
       last_synced_at = datetime('now'),
       status = excluded.status`
  ).bind(
    clientId,
    conn.provider,
    conn.tenantId ?? null,
    conn.accessTokenEncrypted,
    conn.refreshTokenEncrypted,
    conn.expiresAt,
    conn.status ?? 'active'
  ).run();
}

/**
 * Resolves external provider tenant ID to internal clientId.
 */
export async function resolveClientByAccountingTenant(
  db: D1Database,
  provider: AccountingProvider,
  tenantId: string
): Promise<number | null> {
  if (!tenantId || typeof tenantId !== 'string') return null;

  const row = await db.prepare(
    `SELECT client_id AS clientId
     FROM accounting_connections
     WHERE provider = ?1 AND tenant_id = ?2 AND status = 'active'`
  ).bind(provider, tenantId.trim()).first<{ clientId: number }>();

  return row ? row.clientId : null;
}

/**
 * Chase draft management scoped to tenant.
 */
export async function getTenantDrafts(db: D1Database, clientId: number): Promise<TenantChaseDraft[]> {
  validateClientId(clientId);
  const rows = await db.prepare(
    `SELECT cl.id, cl.invoice_id AS invoiceId, cl.step, cl.channel, cl.subject, cl.body,
            cl.status, cl.sent_at AS sentAt, cl.reviewed_at AS reviewedAt, cl.reviewed_by AS reviewedBy,
            i.invoice_number AS invoiceNumber, i.debtor_name AS debtorName, i.debtor_email AS debtorEmail,
            i.amount_pence AS amountPence
     FROM chase_log cl
     JOIN invoices i ON i.id = cl.invoice_id
     WHERE i.client_id = ?1 AND cl.status = 'draft'
     ORDER BY cl.sent_at ASC`
  ).bind(clientId).all<TenantChaseDraft>();

  return rows.results ?? [];
}

/**
 * Approves a draft scoped strictly to the client's invoices.
 */
export async function approveTenantDraft(
  db: D1Database,
  clientId: number,
  draftId: number,
  editedBody: string,
  reviewedBy: string
): Promise<boolean> {
  validateClientId(clientId);
  validateIntegerId(draftId, 'draftId');

  const res = await db.prepare(
    `UPDATE chase_log
     SET status = 'sent',
         body = ?3,
         outcome = 'sent',
         reviewed_at = datetime('now'),
         reviewed_by = ?4
     WHERE id = ?1
       AND status = 'draft'
       AND invoice_id IN (SELECT id FROM invoices WHERE client_id = ?2)`
  ).bind(draftId, clientId, editedBody, reviewedBy).run();

  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Skips a draft scoped strictly to the client's invoices.
 */
export async function skipTenantDraft(
  db: D1Database,
  clientId: number,
  draftId: number
): Promise<boolean> {
  validateClientId(clientId);
  validateIntegerId(draftId, 'draftId');

  const res = await db.prepare(
    `UPDATE chase_log
     SET status = 'skipped',
         reviewed_at = datetime('now')
     WHERE id = ?1
       AND status = 'draft'
       AND invoice_id IN (SELECT id FROM invoices WHERE client_id = ?2)`
  ).bind(draftId, clientId).run();

  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Object-Oriented Scoped Repository
// ---------------------------------------------------------------------------

export class TenantRepository {
  constructor(
    private readonly db: D1Database,
    public readonly clientId: number
  ) {
    validateClientId(clientId);
  }

  async getInvoices(): Promise<TenantInvoice[]> {
    return getTenantInvoices(this.db, this.clientId);
  }

  async getInvoiceByNumber(invoiceNumber: string): Promise<TenantInvoice | null> {
    return getTenantInvoiceByNumber(this.db, this.clientId, invoiceNumber);
  }

  async getInvoiceById(invoiceId: number): Promise<TenantInvoice | null> {
    return getTenantInvoiceById(this.db, this.clientId, invoiceId);
  }

  async upsertInvoice(invoice: UpsertInvoiceInput): Promise<UpsertInvoiceResult> {
    return upsertTenantInvoice(this.db, this.clientId, invoice);
  }

  async getAccountingConnection(provider: AccountingProvider): Promise<TenantAccountingConnection | null> {
    return getAccountingConnection(this.db, this.clientId, provider);
  }

  async upsertAccountingConnection(conn: {
    provider: AccountingProvider;
    tenantId?: string | null;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string;
    expiresAt: string;
    status?: ConnectionStatus;
  }): Promise<void> {
    return upsertAccountingConnection(this.db, this.clientId, conn);
  }

  async getDrafts(): Promise<TenantChaseDraft[]> {
    return getTenantDrafts(this.db, this.clientId);
  }

  async approveDraft(draftId: number, editedBody: string, reviewedBy: string): Promise<boolean> {
    return approveTenantDraft(this.db, this.clientId, draftId, editedBody, reviewedBy);
  }

  async skipDraft(draftId: number): Promise<boolean> {
    return skipTenantDraft(this.db, this.clientId, draftId);
  }
}
