-- Repeating host events (ADR 0012). Additive: one new table and one index.
--
--   - host_event_series: one row per series a host put on their own calendar
--     (MCP `create_event` with `recurrence`). It keeps the rule (a wall clock in
--     the host's zone: first date, start time, length, daily or weekly, every N,
--     weekdays, a count or a last date or neither), the attendees, the dates
--     skipped because something else was there, how far its occurrences are
--     written as bookings (`materialized_until_ms`, a rolling horizon a job
--     extends), and the ONE repeating event the host's calendar holds for it.
--   - Its dated occurrences are ordinary `booking` rows with no event type (ADR
--     0011), linked by the existing, so far unused, `booking.recurring_event_id`.
--     Being bookings, each one is covered by the overlap check and by
--     `booking_no_overlap`, so a series can never double-book the host.
--
-- Migration safety: CREATE TABLE is new and empty. The index on `booking` is a
-- plain CREATE INDEX on a hot table, the precedent of 0039: it reads the table
-- once under a SHARE lock (blocks writes, not reads), which takes milliseconds
-- at today's size; the timeouts make it fail fast rather than queue booking
-- writes, and a failed boot retries. Partial, so the many rows without a series
-- add nothing to it.
SET lock_timeout = '3s';
SET statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS host_event_series (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  host_member_id         TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT,
  location_kind          TEXT,
  time_zone              TEXT NOT NULL,
  start_date             TEXT NOT NULL,
  start_time             TEXT NOT NULL,
  duration_minutes       INTEGER NOT NULL,
  frequency              TEXT NOT NULL,
  interval_count         INTEGER NOT NULL DEFAULT 1,
  weekdays               TEXT NOT NULL DEFAULT '',
  occurrence_count       INTEGER,
  until_date             TEXT,
  attendees              JSONB,
  status                 TEXT NOT NULL DEFAULT 'active',
  materialized_until_ms  BIGINT NOT NULL,
  skipped                JSONB,
  calendar_state         TEXT NOT NULL DEFAULT 'not_connected',
  calendar_destination   TEXT,
  calendar_event_id      TEXT,
  calendar_calendar_id   TEXT,
  calendar_claim         TEXT,
  meeting_url            TEXT,
  split_from             TEXT,
  idempotency_key        TEXT UNIQUE,
  metadata               JSONB,
  created_at             BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS host_event_series_status_idx ON host_event_series (status, materialized_until_ms);
CREATE INDEX IF NOT EXISTS host_event_series_account_idx ON host_event_series (account_id);
CREATE INDEX IF NOT EXISTS booking_recurring_event_idx ON booking (recurring_event_id) WHERE recurring_event_id IS NOT NULL;

RESET statement_timeout;
RESET lock_timeout;
