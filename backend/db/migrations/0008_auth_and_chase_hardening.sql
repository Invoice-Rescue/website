-- Invoice Rescue — auth + chase-pipeline hardening (2026-10-12 pen-test / QA findings)
--
-- 1. consumed_login_tokens: makes portal magic links single-use. Each login token carries a
--    random jti; /portal/verify inserts it here and refuses any token whose jti already exists.
-- 2. clients.session_epoch: session tokens embed the epoch they were issued under; logout bumps
--    it, so every previously issued session for that client stops verifying (stateless HMAC
--    sessions otherwise stay valid for their full 7-day TTL after logout).
-- 3. rate_limits: fixed-window counters for unauthenticated, email-sending routes
--    (/portal/login, /api/lead) — each request there triggers a real send.
-- 4. One pending draft per invoice, enforced by the schema: two overlapping detect-overdue runs
--    could both pass the app-level "no pending draft" check while waiting on Gemini and insert
--    duplicate drafts (both of which could then be approved and sent to the debtor).
--
-- Apply via:  npx wrangler d1 migrations apply invoice-rescue-db --local|--remote
-- Rollback: forward migration dropping the three new objects; session_epoch can stay (unused).

CREATE TABLE IF NOT EXISTS consumed_login_tokens (
  jti TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL              -- unix seconds; rows past this are safe to delete
);

ALTER TABLE clients ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,                    -- e.g. 'portal-login:ip:<addr>'
  window_start INTEGER NOT NULL,           -- unix seconds, aligned to the window size
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Collapse any duplicate pending drafts that already exist (keep the oldest) so the unique
-- index below can be created.
UPDATE chase_log
SET status = 'skipped', reviewed_at = datetime('now'), reviewed_by = 'system: duplicate draft'
WHERE status = 'draft'
  AND id NOT IN (SELECT MIN(id) FROM chase_log WHERE status = 'draft' GROUP BY invoice_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chase_log_one_draft_per_invoice
  ON chase_log (invoice_id) WHERE status = 'draft';
