-- Invoice Rescue — Stripe Webhook Idempotency & Audit Trail
-- Tracks processed webhook events to guarantee at-most-once side-effect execution,
-- reject duplicate event delivery, and guard against out-of-order event delivery.
--
-- Apply via:  npx wrangler d1 migrations apply invoice-rescue-db --local|--remote

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,                       -- Stripe event ID (e.g. evt_...)
  event_type TEXT NOT NULL,                  -- e.g. customer.subscription.updated
  customer_id TEXT,                          -- Stripe customer ID (cus_...)
  created_at_timestamp INTEGER NOT NULL,      -- Stripe event created timestamp (unix seconds)
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_customer_created 
  ON webhook_events (customer_id, created_at_timestamp);
