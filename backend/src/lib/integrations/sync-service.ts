/**
 * Accounting Synchronization Service for Invoice Rescue.
 * Synchronizes invoices from Xero and QuickBooks, reconciles debtor records in D1,
 * enforces multi-tenant isolation, marks settled invoices as 'paid',
 * and halts automated chasing on paid or disputed invoices.
 */

import { decryptToken, encryptToken, refreshProviderTokens, revokeProviderToken } from './oauth-manager';
import { validateClientId } from '../tenant-repo';

export interface NormalizedInvoice {
  externalId: string;
  invoiceNumber: string;
  debtorName: string;
  debtorEmail: string | null;
  amountPence: number;
  currency: string;
  dueDate: string;          // YYYY-MM-DD
  issuedDate: string | null; // YYYY-MM-DD
  isPaid: boolean;
  paidDate: string | null;  // YYYY-MM-DD
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

interface DBConnectionRow {
  id: number;
  client_id: number;
  provider: 'xero' | 'quickbooks';
  tenant_id: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  expires_at: string;
  status: string;
}

export class SyncService {
  constructor(
    private readonly db: D1Database,
    private readonly env: Env
  ) {}

  private getEncryptionSecret(): string {
    const secret = (this.env as any).TOKEN_ENCRYPTION_SECRET || this.env.PORTAL_SESSION_SECRET;
    if (!secret) {
      throw new Error("TOKEN_ENCRYPTION_SECRET configuration error: secret is missing.");
    }
    return secret;
  }

  /**
   * Synchronizes all invoices for a tenant from their active accounting connection.
   */
  async syncInvoices(clientId: number): Promise<SyncResult> {
    validateClientId(clientId);

    const conn = await this.db.prepare(
      `SELECT id, client_id, provider, tenant_id, access_token_encrypted,
              refresh_token_encrypted, expires_at, status
       FROM accounting_connections
       WHERE client_id = ?1 AND status = 'active'
       ORDER BY id DESC`
    ).bind(clientId).first<DBConnectionRow>();

    if (!conn) {
      return {
        success: false,
        clientId,
        invoicesSynced: 0,
        invoicesCreated: 0,
        invoicesUpdated: 0,
        invoicesMarkedPaid: 0,
        reason: 'No active accounting connection found',
      };
    }

    const secretKey = this.getEncryptionSecret();
    const accessToken = await this.resolveFreshAccessToken(conn, secretKey);
    if (!accessToken) {
      return {
        success: false,
        provider: conn.provider,
        clientId,
        invoicesSynced: 0,
        invoicesCreated: 0,
        invoicesUpdated: 0,
        invoicesMarkedPaid: 0,
        reason: 'Failed to obtain fresh access token (connection may be revoked)',
      };
    }

    // Fetch invoices from provider
    let normalizedInvoices: NormalizedInvoice[] = [];
    try {
      if (conn.provider === 'xero') {
        normalizedInvoices = await this.fetchXeroInvoices(accessToken, conn.tenant_id ?? '');
      } else {
        normalizedInvoices = await this.fetchQuickBooksInvoices(accessToken, conn.tenant_id ?? '');
      }
    } catch (fetchErr) {
      return {
        success: false,
        provider: conn.provider,
        clientId,
        invoicesSynced: 0,
        invoicesCreated: 0,
        invoicesUpdated: 0,
        invoicesMarkedPaid: 0,
        reason: `Provider fetch error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      };
    }

    let created = 0;
    let updated = 0;
    let markedPaid = 0;

    for (const norm of normalizedInvoices) {
      const res = await this.reconcileInvoice(clientId, norm);
      if (res === 'created') {
        created++;
        if (norm.isPaid) markedPaid++;
      } else if (res === 'updated') {
        updated++;
      } else if (res === 'marked_paid') {
        updated++;
        markedPaid++;
      }
    }

    // Update connection last_synced_at
    await this.db.prepare(
      `UPDATE accounting_connections SET last_synced_at = datetime('now') WHERE id = ?1`
    ).bind(conn.id).run();

    return {
      success: true,
      provider: conn.provider,
      clientId,
      invoicesSynced: normalizedInvoices.length,
      invoicesCreated: created,
      invoicesUpdated: updated,
      invoicesMarkedPaid: markedPaid,
    };
  }

  /**
   * Synchronizes a single invoice by external provider resource ID.
   */
  async syncSingleInvoice(
    clientId: number,
    provider: 'xero' | 'quickbooks',
    externalInvoiceId: string
  ): Promise<boolean> {
    validateClientId(clientId);
    if (!externalInvoiceId) return false;

    const conn = await this.db.prepare(
      `SELECT id, client_id, provider, tenant_id, access_token_encrypted,
              refresh_token_encrypted, expires_at, status
       FROM accounting_connections
       WHERE client_id = ?1 AND provider = ?2 AND status = 'active'`
    ).bind(clientId, provider).first<DBConnectionRow>();

    if (!conn) return false;

    const secretKey = this.getEncryptionSecret();
    const accessToken = await this.resolveFreshAccessToken(conn, secretKey);
    if (!accessToken) return false;

    let norm: NormalizedInvoice | null = null;
    try {
      if (provider === 'xero') {
        norm = await this.fetchSingleXeroInvoice(accessToken, conn.tenant_id ?? '', externalInvoiceId);
      } else {
        norm = await this.fetchSingleQuickBooksInvoice(accessToken, conn.tenant_id ?? '', externalInvoiceId);
      }
    } catch {
      return false;
    }

    if (!norm) return false;

    await this.reconcileInvoice(clientId, norm);
    return true;
  }

  /**
   * Disconnects an accounting connection for a tenant and revokes provider tokens with error logging.
   */
  async revokeConnection(clientId: number, provider: 'xero' | 'quickbooks'): Promise<boolean> {
    validateClientId(clientId);
    const conn = await this.db.prepare(
      `SELECT id, refresh_token_encrypted FROM accounting_connections WHERE client_id = ?1 AND provider = ?2`
    ).bind(clientId, provider).first<{ id: number; refresh_token_encrypted: string }>();

    if (!conn) return false;

    const secretKey = this.getEncryptionSecret();
    const creds = provider === 'xero'
      ? { clientId: (this.env as any).XERO_CLIENT_ID || '', clientSecret: (this.env as any).XERO_CLIENT_SECRET || '' }
      : { clientId: (this.env as any).QUICKBOOKS_CLIENT_ID || '', clientSecret: (this.env as any).QUICKBOOKS_CLIENT_SECRET || '' };

    try {
      const refreshToken = await decryptToken(conn.refresh_token_encrypted, secretKey);
      await revokeProviderToken(provider, refreshToken, creds);
    } catch (err) {
      console.warn(`External token revocation encountered an error for provider ${provider}:`, err);
    }

    await this.db.prepare(`DELETE FROM accounting_connections WHERE id = ?1`).bind(conn.id).run();
    await this.db.prepare(
      `UPDATE clients SET accounting_source = NULL WHERE id = ?1 AND accounting_source = ?2`
    ).bind(clientId, provider).run();

    return true;
  }

  /**
   * Reconciles a normalized invoice into D1 for a given tenant.
   */
  async reconcileInvoice(
    clientId: number,
    norm: NormalizedInvoice
  ): Promise<'created' | 'updated' | 'marked_paid' | 'unchanged'> {
    const existing = await this.db.prepare(
      `SELECT id, invoice_number, amount_pence, status, due_date, paid_date
       FROM invoices
       WHERE client_id = ?1 AND invoice_number = ?2`
    ).bind(clientId, norm.invoiceNumber).first<{
      id: number;
      invoice_number: string;
      amount_pence: number;
      status: string;
      due_date: string;
      paid_date: string | null;
    }>();

    if (existing) {
      // 1. Invoice is Settled / Paid in external provider
      if (norm.isPaid) {
        if (existing.status !== 'paid') {
          await this.db.batch([
            this.db.prepare(
              `UPDATE invoices
               SET status = 'paid',
                   paid_date = COALESCE(?1, date('now')),
                   amount_pence = ?2,
                   external_id = ?3,
                   last_synced_at = datetime('now')
               WHERE id = ?4`
            ).bind(norm.paidDate, norm.amountPence, norm.externalId, existing.id),

            // Halt automated chases on paid invoice: cancel pending review-queue drafts
            this.db.prepare(
              `UPDATE chase_log
               SET status = 'skipped',
                   reviewed_at = datetime('now')
               WHERE invoice_id = ?1 AND status = 'draft'`
            ).bind(existing.id),
          ]);
          return 'marked_paid';
        }
        return 'unchanged';
      }

      // 2. Invoice is Voided or Disputed in provider
      if (norm.isDisputedOrVoid) {
        if (existing.status !== 'disputed') {
          await this.db.batch([
            this.db.prepare(
              `UPDATE invoices
               SET status = 'disputed',
                   external_id = ?1,
                   last_synced_at = datetime('now')
               WHERE id = ?2`
            ).bind(norm.externalId, existing.id),

            this.db.prepare(
              `UPDATE chase_log
               SET status = 'skipped',
                   reviewed_at = datetime('now')
               WHERE invoice_id = ?1 AND status = 'draft'`
            ).bind(existing.id),
          ]);
          return 'updated';
        }
        return 'unchanged';
      }

      // 3. Invoice remains active / overdue - update details if changed, but protect paid invoices!
      if (existing.status !== 'paid') {
        await this.db.prepare(
          `UPDATE invoices
           SET amount_pence = ?1,
               due_date = ?2,
               debtor_name = ?3,
               debtor_email = COALESCE(?4, debtor_email),
               external_id = ?5,
               last_synced_at = datetime('now')
           WHERE id = ?6`
        ).bind(norm.amountPence, norm.dueDate, norm.debtorName, norm.debtorEmail, norm.externalId, existing.id).run();
        return 'updated';
      }

      return 'unchanged';
    }

    // Invoice does not exist in D1 yet
    if (norm.isPaid) {
      await this.db.prepare(
        `INSERT INTO invoices
         (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, paid_date, external_id, last_synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'paid', COALESCE(?9, date('now')), ?10, datetime('now'))`
      ).bind(
        clientId,
        norm.debtorName,
        norm.debtorEmail,
        norm.invoiceNumber,
        norm.amountPence,
        norm.currency,
        norm.issuedDate,
        norm.dueDate,
        norm.paidDate,
        norm.externalId
      ).run();
      return 'created';
    }

    // Insert active overdue record
    await this.db.prepare(
      `INSERT INTO invoices
       (client_id, debtor_name, debtor_email, invoice_number, amount_pence, currency, issued_date, due_date, status, external_id, last_synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'overdue', ?9, datetime('now'))`
    ).bind(
      clientId,
      norm.debtorName,
      norm.debtorEmail,
      norm.invoiceNumber,
      norm.amountPence,
      norm.currency,
      norm.issuedDate,
      norm.dueDate,
      norm.externalId
    ).run();
    return 'created';
  }

  /**
   * Resolves token and auto-refreshes if expiring within 5 minutes.
   */
  private async resolveFreshAccessToken(conn: DBConnectionRow, secretKey: string): Promise<string | null> {
    const expiresAtMs = new Date(conn.expires_at).getTime();
    const isExpiringSoon = !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs - 5 * 60 * 1000;

    if (isExpiringSoon) {
      try {
        const decryptedRefresh = await decryptToken(conn.refresh_token_encrypted, secretKey);
        const creds = conn.provider === 'xero'
          ? { clientId: (this.env as any).XERO_CLIENT_ID || '', clientSecret: (this.env as any).XERO_CLIENT_SECRET || '' }
          : { clientId: (this.env as any).QUICKBOOKS_CLIENT_ID || '', clientSecret: (this.env as any).QUICKBOOKS_CLIENT_SECRET || '' };

        const refreshed = await refreshProviderTokens(conn.provider, decryptedRefresh, creds);

        const newAccessEncrypted = await encryptToken(refreshed.accessToken, secretKey);
        const newRefreshEncrypted = await encryptToken(refreshed.refreshToken, secretKey);
        const newExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();

        await this.db.prepare(
          `UPDATE accounting_connections
           SET access_token_encrypted = ?1,
               refresh_token_encrypted = ?2,
               expires_at = ?3,
               status = 'active',
               last_synced_at = datetime('now')
           WHERE id = ?4`
        ).bind(newAccessEncrypted, newRefreshEncrypted, newExpiresAt, conn.id).run();

        return refreshed.accessToken;
      } catch (err: any) {
        if (err?.message?.includes('invalid_grant') || err?.message?.includes('revoked')) {
          await this.db.prepare(
            `UPDATE accounting_connections SET status = 'revoked' WHERE id = ?1`
          ).bind(conn.id).run();
          return null;
        }
        console.warn(`External token refresh/revocation encountered an error for provider ${conn.provider}:`, err);
        // Fall back to existing decrypted token if network error
        try {
          return await decryptToken(conn.access_token_encrypted, secretKey);
        } catch {
          return null;
        }
      }
    }

    return await decryptToken(conn.access_token_encrypted, secretKey);
  }

  private async fetchXeroInvoices(accessToken: string, tenantId: string): Promise<NormalizedInvoice[]> {
    const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED,PAID", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Xero API error (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { Invoices?: any[] };
    return (data.Invoices ?? []).map(inv => this.normalizeXeroInvoice(inv));
  }

  private async fetchSingleXeroInvoice(accessToken: string, tenantId: string, invoiceId: string): Promise<NormalizedInvoice | null> {
    const res = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { Invoices?: any[] };
    const inv = data.Invoices?.[0];
    return inv ? this.normalizeXeroInvoice(inv) : null;
  }

  private normalizeXeroInvoice(inv: any): NormalizedInvoice {
    const amountDue = typeof inv.AmountDue === 'number' ? inv.AmountDue : (inv.Total ?? 0);
    const amountPence = Math.max(1, Math.round(amountDue * 100));
    const isPaid = inv.Status === 'PAID' || (typeof inv.AmountDue === 'number' && inv.AmountDue <= 0);
    const isDisputedOrVoid = inv.Status === 'VOIDED' || inv.Status === 'DELETED';

    const parseXeroDate = (raw: string | undefined): string => {
      if (!raw) return new Date().toISOString().slice(0, 10);
      if (raw.startsWith('/Date(')) {
        const ms = parseInt(raw.slice(6), 10);
        return new Date(ms).toISOString().slice(0, 10);
      }
      return raw.slice(0, 10);
    };

    return {
      externalId: String(inv.InvoiceID || inv.InvoiceNumber || ''),
      invoiceNumber: String(inv.InvoiceNumber || inv.InvoiceID || 'UNKNOWN'),
      debtorName: inv.Contact?.Name || 'Unknown Debtor',
      debtorEmail: inv.Contact?.EmailAddress || null,
      amountPence,
      currency: inv.CurrencyCode || 'GBP',
      dueDate: parseXeroDate(inv.DueDateString || inv.DueDate),
      issuedDate: parseXeroDate(inv.DateString || inv.Date),
      isPaid,
      paidDate: isPaid ? (inv.FullyPaidOnDate ? parseXeroDate(inv.FullyPaidOnDate) : new Date().toISOString().slice(0, 10)) : null,
      isDisputedOrVoid,
    };
  }

  private async fetchQuickBooksInvoices(accessToken: string, realmId: string): Promise<NormalizedInvoice[]> {
    const query = encodeURIComponent("SELECT * FROM Invoice MAXRESULTS 1000");
    const res = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${query}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`QuickBooks API error (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { QueryResponse?: { Invoice?: any[] } };
    return (data.QueryResponse?.Invoice ?? []).map(inv => this.normalizeQuickBooksInvoice(inv));
  }

  private async fetchSingleQuickBooksInvoice(accessToken: string, realmId: string, invoiceId: string): Promise<NormalizedInvoice | null> {
    const res = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/invoice/${invoiceId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { Invoice?: any };
    return data.Invoice ? this.normalizeQuickBooksInvoice(data.Invoice) : null;
  }

  private normalizeQuickBooksInvoice(inv: any): NormalizedInvoice {
    const balance = typeof inv.Balance === 'number' ? inv.Balance : (inv.TotalAmt ?? 0);
    const amountPence = Math.max(1, Math.round(balance * 100));
    const isPaid = typeof inv.Balance === 'number' && inv.Balance <= 0;
    const isDisputedOrVoid = inv.status === 'Deleted' || inv.Status === 'Deleted';

    return {
      externalId: String(inv.Id || inv.DocNumber || ''),
      invoiceNumber: String(inv.DocNumber || inv.Id || 'UNKNOWN'),
      debtorName: inv.CustomerRef?.name || 'Unknown Debtor',
      debtorEmail: inv.BillEmail?.Address || null,
      amountPence,
      currency: inv.CurrencyRef?.value || 'GBP',
      dueDate: inv.DueDate ? String(inv.DueDate).slice(0, 10) : new Date().toISOString().slice(0, 10),
      issuedDate: inv.TxnDate ? String(inv.TxnDate).slice(0, 10) : null,
      isPaid,
      paidDate: isPaid ? new Date().toISOString().slice(0, 10) : null,
      isDisputedOrVoid,
    };
  }
}
