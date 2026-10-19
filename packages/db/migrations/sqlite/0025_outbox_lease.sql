-- See migrations/postgres/0026_outbox_lease.sql for the rationale.
--
-- Nullable, no default: every existing row reads as not leased and never
-- failed, and is claimed and retried exactly like a new one.

ALTER TABLE outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE outbox ADD COLUMN lease_token TEXT;
ALTER TABLE outbox ADD COLUMN first_failed_at INTEGER;
ALTER TABLE outbox ADD COLUMN order_key TEXT;
