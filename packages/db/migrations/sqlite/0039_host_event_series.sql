-- See migrations/postgres/0040_host_event_series.sql for the rationale (ADR 0012).
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
  attendees              TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  materialized_until_ms  INTEGER NOT NULL,
  skipped                TEXT,
  calendar_state         TEXT NOT NULL DEFAULT 'not_connected',
  calendar_destination   TEXT,
  calendar_event_id      TEXT,
  calendar_calendar_id   TEXT,
  calendar_claim         TEXT,
  meeting_url            TEXT,
  split_from             TEXT,
  idempotency_key        TEXT UNIQUE,
  metadata               TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS host_event_series_status_idx ON host_event_series (status, materialized_until_ms);
CREATE INDEX IF NOT EXISTS host_event_series_account_idx ON host_event_series (account_id);
CREATE INDEX IF NOT EXISTS booking_recurring_event_idx ON booking (recurring_event_id) WHERE recurring_event_id IS NOT NULL;
