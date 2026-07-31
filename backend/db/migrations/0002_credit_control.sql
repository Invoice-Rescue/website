-- Invoice Rescue — credit-control engine additions
-- Adds the columns docs/credit-control-system-design.md §3 calls for, on top
-- of 0001_initial_schema.sql. Already live in production (applied by hand
-- 2026-07-19, before this repo tracked migrations) — see 0001's header and
-- CLAUDE.md for how this is now baselined in d1_migrations.
-- Apply via:  npx wrangler d1 migrations apply invoice-rescue-db --local|--remote

ALTER TABLE invoices ADD COLUMN external_id TEXT;
ALTER TABLE invoices ADD COLUMN last_synced_at TEXT;

ALTER TABLE chase_log ADD COLUMN body TEXT;
ALTER TABLE chase_log ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE chase_log ADD COLUMN reviewed_at TEXT;

ALTER TABLE clients ADD COLUMN voice_notes TEXT;
