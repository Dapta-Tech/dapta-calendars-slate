-- Webhook delivery history (SAFE, additive): one row per real delivery
-- attempt so integrators can see from the dashboard whether their hooks are
-- landing — before this, only the manual test ping gave any signal. Retention
-- is enforced in code (last N per webhook), not by the schema.

CREATE TABLE webhook_delivery (
  id          TEXT PRIMARY KEY,
  webhook_id  TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  event       TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  status_code INTEGER,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX webhook_delivery_hook_idx ON webhook_delivery (webhook_id, created_at);
