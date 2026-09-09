-- Duplicate-booking guard (#69 / AB1 #95). Additive and SAFE.
--
-- The SQLite twin of postgres/0015_duplicate_booking_guard.sql — see that file
-- for the full reasoning. Two additive changes against two existing tables, so
-- this file is order-independent with respect to any other unit's migration
-- sharing the number 0014 (#71, Mechanical conventions).
--
-- 1. event_type.prevent_duplicate_bookings — per-event-type switch, DEFAULT 0,
--    so every already-saved event type behaves exactly as it does today.
-- 2. booking_attendee.email_normalized — `lower(trim(email))`, indexed, the
--    value the guard matches on. `+tags` are NOT stripped (#69).
--
-- email_normalized is NULLABLE on purpose (booking_guest's twin is NOT NULL):
-- migrations land before the API that writes it, so rows inserted in that
-- window carry NULL, and SQLite's ALTER TABLE ADD COLUMN cannot take a
-- per-row default anyway. Every read coalesces instead.
--
-- No IF NOT EXISTS on ADD COLUMN — SQLite has no such form; migrate.ts applies
-- each file once, keyed on its filename.

ALTER TABLE event_type ADD COLUMN prevent_duplicate_bookings INTEGER NOT NULL DEFAULT 0;

ALTER TABLE booking_attendee ADD COLUMN email_normalized TEXT;

UPDATE booking_attendee
   SET email_normalized = lower(trim(email))
 WHERE email_normalized IS NULL;

-- Indexed as the EXPRESSION the guard matches on, not the bare column — the
-- read is COALESCE(email_normalized, lower(trim(email))), which a plain
-- column index cannot answer. SQLite supports expression indexes over
-- deterministic built-ins, which coalesce/lower/trim are.
CREATE INDEX IF NOT EXISTS booking_attendee_email_normalized_idx
  ON booking_attendee (COALESCE(email_normalized, lower(trim(email))));

-- The guard's outer filter; no existing index on `booking` leads with
-- event_type_id. See the Postgres twin.
CREATE INDEX IF NOT EXISTS booking_event_type_status_end_idx
  ON booking (event_type_id, status, end_ms);
