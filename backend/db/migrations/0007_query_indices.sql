-- Migration: 0007_query_indices.sql
-- High-frequency performance indices for Edge Infrastructure & Deliverability Controls (Milestone M4 / R4)

CREATE INDEX IF NOT EXISTS idx_chase_log_status ON chase_log(status);
CREATE INDEX IF NOT EXISTS idx_accounting_connections_lookup ON accounting_connections(provider, tenant_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_invoices_client_due ON invoices(client_id, due_date DESC);
