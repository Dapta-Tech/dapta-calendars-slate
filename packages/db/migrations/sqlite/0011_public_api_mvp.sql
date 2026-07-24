-- Additive public-API MVP state: provider-calendar discovery/cache,
-- mutation replay records, post-create guests, and v2 reschedule linkage.

ALTER TABLE booking ADD COLUMN rescheduled_from_uid TEXT;
ALTER TABLE booking ADD COLUMN rescheduled_to_uid TEXT;
ALTER TABLE booking ADD COLUMN rescheduling_reason TEXT;
ALTER TABLE booking ADD COLUMN rescheduled_by_email TEXT;

CREATE INDEX booking_rescheduled_from_idx ON booking (rescheduled_from_uid);
CREATE INDEX booking_rescheduled_to_idx ON booking (rescheduled_to_uid);

CREATE TABLE booking_guest (
  id               TEXT PRIMARY KEY,
  booking_id       TEXT NOT NULL,
  email            TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  name             TEXT,
  time_zone        TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (booking_id, email_normalized)
);
CREATE INDEX booking_guest_booking_idx ON booking_guest (booking_id);

CREATE TABLE provider_calendar (
  id                       TEXT PRIMARY KEY,
  account_id               TEXT NOT NULL,
  member_id                TEXT NOT NULL,
  connected_calendar_id    TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  name                     TEXT NOT NULL,
  email                    TEXT,
  is_primary               INTEGER NOT NULL DEFAULT 0,
  read_only                INTEGER NOT NULL DEFAULT 1,
  access_role              TEXT NOT NULL DEFAULT 'none',
  source                   TEXT NOT NULL DEFAULT 'shared',
  can_read                 INTEGER NOT NULL DEFAULT 1,
  can_read_free_busy       INTEGER NOT NULL DEFAULT 1,
  can_create               INTEGER NOT NULL DEFAULT 0,
  can_update               INTEGER NOT NULL DEFAULT 0,
  can_delete               INTEGER NOT NULL DEFAULT 0,
  sync_status              TEXT NOT NULL DEFAULT 'healthy',
  last_synced_at           INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE (connected_calendar_id, external_id)
);
CREATE INDEX provider_calendar_account_idx ON provider_calendar (account_id, id);
CREATE INDEX provider_calendar_connection_idx ON provider_calendar (connected_calendar_id);

CREATE TABLE api_idempotency (
  id             TEXT PRIMARY KEY,
  namespace_hash TEXT NOT NULL UNIQUE,
  account_id     TEXT NOT NULL,
  api_key_id     TEXT NOT NULL,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status_code    INTEGER,
  response_body  TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX api_idempotency_expiry_idx ON api_idempotency (expires_at);
