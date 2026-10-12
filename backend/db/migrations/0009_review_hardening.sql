-- Invoice Rescue — follow-ups from PR #14 review (2026-10-12)
--
-- 1. chase_log.dispatch_lease_until: approve used to mark a draft 'sent' BEFORE dispatching, so a
--    Worker killed mid-send left a permanent false "sent" audit record. The draft now stays
--    'draft' (still covered by the one-pending-draft index) while a short lease (unix seconds)
--    blocks concurrent approvals; it becomes 'sent' only after delivery succeeds. An expired lease
--    means the attempt died — the draft is approvable again.
-- 2. Case-insensitive unique contact_email: the app-level duplicate check in POST /api/clients is
--    read-then-insert, so two concurrent creates could both pass it. Production had no duplicates
--    when this was written (checked 2026-10-12).
-- 3. rate_limits(window_start) index for the global expired-window prune.
--
-- Apply via:  npx wrangler d1 migrations apply invoice-rescue-db --local|--remote
-- Rollback: forward migration dropping the two indexes; the column can stay (NULL = no lease).

ALTER TABLE chase_log ADD COLUMN dispatch_lease_until INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_contact_email_ci ON clients (lower(contact_email));

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
