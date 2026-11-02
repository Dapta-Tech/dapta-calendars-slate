-- Index `booking (account_id, updated_at)` for the MCP change feed.
--
-- `list_bookings` / `list_pending_bookings` with `updated_since` (#336) filter on
-- `b.account_id = ? AND b.updated_at >= ?` and, with neither `from` nor `to`, put
-- no bound on `start_ms`, so `booking_account_idx (account_id, start_ms)` gives
-- them no range and the query reads every booking of the account. An agent that
-- polls the feed every few minutes makes that one scan per poll.
--
-- Migration safety: a plain (not CONCURRENTLY) CREATE INDEX on an existing, hot
-- table. It reads the table once and holds a SHARE lock while it does, which
-- blocks writes (not reads). The booking table is small (hundreds to a few
-- thousand rows per deployment today), so the build takes milliseconds. The
-- timeouts make it fail fast instead of queueing booking writes behind a long
-- transaction; a failed boot retries the migration. A deployment with a large
-- booking table can create the same index CONCURRENTLY by hand first: IF NOT
-- EXISTS then makes this a no-op.
SET lock_timeout = '3s';
SET statement_timeout = '15s';

CREATE INDEX IF NOT EXISTS booking_account_updated_idx ON booking (account_id, updated_at);

RESET statement_timeout;
RESET lock_timeout;
