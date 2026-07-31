-- Invoice Rescue — DB-level integrity
-- Promotes the enum-like values the Worker currently validates only in app
-- code (PLANS, ACCOUNTING_SOURCES, OVERDUE_BANDS in backend/src/index.ts, and
-- the status/outcome literals used throughout) into CHECK constraints, and
-- adds a UNIQUE guard against re-importing the same invoice twice (the CSV
-- importer has no dedupe today, so re-running an import silently duplicates
-- rows).
--
-- SQLite has no ALTER TABLE ADD CONSTRAINT, so tables gaining a CHECK are
-- rebuilt (rename/create/copy/drop for leads, which has rows; plain
-- drop+recreate for clients/invoices/chase_log, which were empty in
-- production as of 2026-07-28 — confirmed via d1_database_query before
-- writing this migration).
--
-- Rollback: D1/wrangler migrations have no automatic "down". To revert,
-- write a new forward migration that rebuilds these tables again without the
-- CHECK/UNIQUE clauses below.

PRAGMA defer_foreign_keys = TRUE;

ALTER TABLE leads RENAME TO leads_old;

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  overdue_band TEXT CHECK (overdue_band IS NULL OR overdue_band IN ('under_5k', '5k_25k', '25k_100k', 'over_100k', 'not_sure')),
  message TEXT,
  source TEXT DEFAULT 'landing_page',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'call_booked', 'client', 'lost')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO leads (id, name, email, company, overdue_band, message, source, status, created_at)
SELECT id, name, email, company, overdue_band, message, source, status, created_at FROM leads_old;

DROP TABLE leads_old;

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

DROP TABLE chase_log;
DROP TABLE invoices;
DROP TABLE clients;

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'engine' CHECK (plan IN ('foundation', 'engine', 'operator')),
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'paused', 'churned')),
  accounting_source TEXT CHECK (accounting_source IS NULL OR accounting_source IN ('xero', 'quickbooks', 'csv')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voice_notes TEXT
);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  invoice_number TEXT NOT NULL,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  issued_date TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'overdue' CHECK (status IN ('overdue', 'promised', 'disputed', 'paid', 'escalated')),
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  external_id TEXT,
  last_synced_at TEXT,
  UNIQUE (client_id, invoice_number)
);

CREATE TABLE chase_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  step INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'replied', 'promised', 'paid', 'bounced')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  body TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'skipped')),
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_chase_invoice ON chase_log(invoice_id);
