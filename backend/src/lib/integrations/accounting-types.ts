export interface AccountingConnection {
  id: number;
  clientId: number;
  provider: 'xero' | 'quickbooks';
  tenantId?: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  expiresAt: string;
  lastSyncedAt?: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
}

export interface WebhookEvent {
  id: string;
  provider: 'xero' | 'quickbooks';
  eventType: string;
  payload: string;
  processedAt: string;
}
