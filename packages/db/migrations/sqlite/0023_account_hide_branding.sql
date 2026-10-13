-- See migrations/postgres/0024_account_hide_branding.sql for the rationale.
--
-- A 0/1 INTEGER, the standing dual-dialect convention for a flag (event_type.hidden,
-- webhook.active), so the repository reads the same value on both engines.

ALTER TABLE account ADD COLUMN hide_branding INTEGER NOT NULL DEFAULT 0;
