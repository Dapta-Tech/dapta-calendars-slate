-- The outbox claims rows with a LEASE, and keeps retrying a failing row for a
-- time HORIZON rather than a handful of seconds (additive + SAFE).
--
--   - outbox.lease_until: epoch-ms until which a worker owns the row. A worker
--     claims a due row by setting it (only when it is NULL or already past), so
--     two API replicas never deliver the same row at once, and a replica that
--     dies mid-delivery has its rows taken over once the lease runs out.
--   - outbox.lease_token: who holds the lease. Marking a row done, retried or
--     failed checks it, so a worker whose lease ran out cannot overwrite the
--     outcome of the worker that took the row over.
--   - outbox.first_failed_at: epoch-ms of the row's first failed attempt. The
--     retry horizon (OUTBOX_RETRY_HORIZON_MS) is counted from here, not from
--     created_at: a reminder is created weeks before it is due.
--   - outbox.order_key: rows of one kind that share it are delivered one at a
--     time, in the order queued (a booking's calendar writes; one side's mail
--     about a booking; one subscriber's events about a booking), so a retry
--     that waits hours never lets a later row overtake it. NULL falls back to
--     the booking (the subscriber, for a webhook row), as before this column.
--
-- NULL on every existing row, which reads as "not leased, never failed": the
-- worker claims and retries those exactly as it would a new row. Rows already
-- part-way through their retries start counting the horizon at their next
-- failure.
--
-- Migration safety: four ADD COLUMNs, nullable, no default: catalog-only in
-- Postgres (no rewrite, no scan). No index is added: the claim reads through
-- the existing outbox_due_idx (status, next_attempt_at). The brief ACCESS
-- EXCLUSIVE lock is bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry rather than queue the worker behind it.
SET lock_timeout = '5s';

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_until BIGINT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS first_failed_at BIGINT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS order_key TEXT;

RESET lock_timeout;
