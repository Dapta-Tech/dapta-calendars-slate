-- Custom hours for one event type: `schedule.event_type_id`.
--
-- An event type may carry its own weekly hours instead of pointing at one of
-- the host's reusable schedules. Those hours are stored as an ordinary
-- `schedule` + `availability` rows owned by the event (this column set), and
-- `event_type.schedule_id` points at it, so slot generation reads them through
-- the path it already has. NULL (every existing row) is a reusable schedule:
-- listed on the Availability page, pickable by events, eligible as a default.
-- A non-NULL row is private to that event and excluded from all three.
--
-- Migration safety: additive. ADD COLUMN with no default is a catalog-only
-- change in Postgres (no table rewrite). The index is built on a small table
-- (one row per schedule); the timeouts make it fail fast rather than queue
-- writes behind a long transaction, and a failed boot retries the migration.
SET lock_timeout = '3s';
SET statement_timeout = '15s';

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS event_type_id TEXT;
CREATE INDEX IF NOT EXISTS schedule_event_type_idx ON schedule (event_type_id);

RESET statement_timeout;
RESET lock_timeout;
