CREATE TABLE IF NOT EXISTS accounting_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')),
    tenant_id TEXT,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_synced_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'revoked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_connections_client_provider ON accounting_connections (client_id, provider);

CREATE TABLE IF NOT EXISTS accounting_webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('xero', 'quickbooks')),
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
