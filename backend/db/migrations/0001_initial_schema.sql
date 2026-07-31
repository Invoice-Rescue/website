-- Invoice Rescue — D1 schema
-- Baseline migration. Applied by hand on 2026-07-15 (npx wrangler d1 execute
-- --file=./backend/db/schema.sql) before this repo tracked migrations; the
-- d1_migrations bookkeeping table was backfilled to record this and
-- 0002_credit_control.sql as already-applied without re-running them (see
-- CLAUDE.md). New environments get this via:
--   npx wrangler d1 migrations apply invoice-rescue-db --local|--remote

-- Leads captured from the landing page free-audit form
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  overdue_band TEXT,           -- under_5k | 5k_25k | 25k_100k | over_100k | not_sure
  message TEXT,
  source TEXT DEFAULT 'landing_page',
  status TEXT NOT NULL DEFAULT 'new',   -- new | contacted | call_booked | client | lost
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Paying clients (the delivery engine grows from here)
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'engine',  -- foundation | engine | operator
  status TEXT NOT NULL DEFAULT 'onboarding', -- onboarding | active | paused | churned
  accounting_source TEXT,               -- xero | quickbooks | csv
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invoices being chased on behalf of clients (amounts in pence — never floats for money)
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  debtor_name TEXT NOT NULL,
  debtor_email TEXT,
  invoice_number TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  issued_date TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'overdue', -- overdue | promised | disputed | paid | escalated
  paid_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit trail of every chase action taken
CREATE TABLE IF NOT EXISTS chase_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  step INTEGER NOT NULL,        -- 1 = gentle reminder, 2 = firm, 3 = formal notice ...
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  outcome TEXT,                 -- sent | replied | promised | paid | bounced
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, due_date);
CREATE INDEX IF NOT EXISTS idx_chase_invoice ON chase_log(invoice_id);
