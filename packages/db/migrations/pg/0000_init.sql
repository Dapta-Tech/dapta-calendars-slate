-- Initial schema (Postgres) — THE SOURCE OF TRUTH. Postgres is designed to full
-- power here (jsonb, the anti-double-booking EXCLUDE constraint, proper
-- indexes); migrations/sqlite/0000_init.sql is a portable SUBSET for dev.
--
-- The production guarantee SQLite cannot express: a btree_gist EXCLUDE
-- constraint over the [start_ms, end_ms) interval per host, gated on
-- status='accepted'. Two overlapping accepted bookings for the same host become
-- physically impossible; the app maps the resulting 23P01 exclusion_violation
-- to 409 SLOT_TAKEN. CI exercises this on real Postgres on every PR.
--
-- Migration safety: btree_gist is created IF NOT EXISTS; all statements here are
-- CREATE-only (SAFE — no locks on existing data, this is the initial baseline).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE account (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE member (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  handle              TEXT,
  display_name        TEXT,
  email               TEXT,
  avatar_url          TEXT,
  time_zone           TEXT NOT NULL DEFAULT 'UTC',
  default_schedule_id TEXT,
  created_at          BIGINT NOT NULL
);
CREATE UNIQUE INDEX member_account_handle_idx ON member (account_id, handle);

CREATE TABLE schedule (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  time_zone  TEXT NOT NULL DEFAULT 'UTC',
  created_at BIGINT NOT NULL
);
CREATE INDEX schedule_member_idx ON schedule (member_id);

CREATE TABLE availability (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  days        TEXT,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  date        TEXT
);
CREATE INDEX availability_schedule_idx ON availability (schedule_id);

CREATE TABLE event_type (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL,
  member_id              TEXT NOT NULL,
  slug                   TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT,
  length_minutes         INTEGER NOT NULL,
  schedule_id            TEXT,
  hidden                 INTEGER NOT NULL DEFAULT 0,
  minimum_booking_notice INTEGER NOT NULL DEFAULT 120,
  before_event_buffer    INTEGER NOT NULL DEFAULT 0,
  after_event_buffer     INTEGER NOT NULL DEFAULT 0,
  slot_interval          INTEGER,
  created_at             BIGINT NOT NULL
);
CREATE UNIQUE INDEX event_type_member_slug_idx ON event_type (account_id, member_id, slug);

CREATE TABLE booking (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL,
  uid                 TEXT NOT NULL UNIQUE,
  event_type_id       TEXT,
  host_member_id      TEXT,
  title               TEXT NOT NULL,
  start_ms            BIGINT NOT NULL,
  end_ms              BIGINT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'accepted',
  location            TEXT,
  meeting_url         TEXT,
  metadata            JSONB,
  cancellation_reason TEXT,
  idempotency_key     TEXT UNIQUE,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);
CREATE INDEX booking_host_status_idx ON booking (host_member_id, status, start_ms, end_ms);

-- The DB-level backstop: no two accepted bookings for one host may overlap.
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    host_member_id WITH =,
    int8range(start_ms, end_ms, '[)') WITH &&
  ) WHERE (status = 'accepted');

CREATE TABLE booking_attendee (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  time_zone  TEXT,
  notes      TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX booking_attendee_booking_idx ON booking_attendee (booking_id);
