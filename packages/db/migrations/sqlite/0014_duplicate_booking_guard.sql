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

CREATE INDEX IF NOT EXISTS booking_attendee_email_normalized_idx
  ON booking_attendee (email_normalized);
