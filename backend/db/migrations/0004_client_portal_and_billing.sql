-- Invoice Rescue — client portal + Stripe billing
-- Adds: a Stripe customer link per client (for the self-serve billing
-- portal), and a reviewed_by label on chase_log (the "reviewed and approved
-- by a human" audit trail shown to clients in /portal — see
-- backend/src/lib/portal.ts). Both are plain nullable columns, so a simple
-- ADD COLUMN is enough — no CHECK constraint, no table rebuild needed
-- (contrast with 0003_add_check_constraints.sql).
--
-- Apply via:  npx wrangler d1 migrations apply invoice-rescue-db --local|--remote

ALTER TABLE clients ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE chase_log ADD COLUMN reviewed_by TEXT;
