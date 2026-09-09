-- Duplicate-booking guard (#69 / AB1 #95). Additive and SAFE.
--
-- Two independent additive changes against two tables that already exist, so
-- this file is order-independent with respect to any other unit's migration
-- that happens to share the number 0015 (#71, Mechanical conventions;
-- migrate.ts keys `_migrations` on the FILENAME, not on the number).
--
-- 1. event_type.prevent_duplicate_bookings
--
-- A per-event-type switch: when 1, one normalized email may hold at most one
-- UPCOMING booking (accepted or pending, end_ms > now) on this event type.
-- DEFAULT 0 is the whole compatibility story — every already-saved event type
-- keeps behaving exactly as it does today, and the host opts in per event.
--
-- Deliberately a boolean and not a cap of N: email is verified nowhere in this
-- product, so N > 1 defends no better than 1 (#69). This is a product feature
-- that prevents accidents, NOT a security control — the security control is
-- the per-IP limiter in apps/api/src/rate-limit.ts.
--
-- 2. booking_attendee.email_normalized
--
-- `lower(trim(email))`, the value the guard matches on. `+tags` are NOT
-- stripped: Gmail folds them into one mailbox but most providers do not, and
-- collapsing them eventually blocks a legitimately distinct person for a
-- defence a throwaway address walks around anyway (#69).
--
-- NULLABLE, unlike booking_guest.email_normalized beside it. Migrations land
-- before the API code that writes the column, and during that window the
-- running deployment keeps inserting attendee rows with no value for it. A
-- NOT NULL column would either reject those inserts or need a default that
-- lies about the row. Every read coalesces instead —
-- COALESCE(email_normalized, lower(trim(email))) — so a row written by an
-- older or external writer still matches correctly.
--
-- ADD COLUMN with a constant default is a metadata-only op in modern Postgres:
-- no table rewrite, no long-lived lock on existing rows. The backfill below is
-- a plain UPDATE over an additive column nothing reads yet.

ALTER TABLE event_type
  ADD COLUMN IF NOT EXISTS prevent_duplicate_bookings INTEGER NOT NULL DEFAULT 0;

ALTER TABLE booking_attendee
  ADD COLUMN IF NOT EXISTS email_normalized TEXT;

UPDATE booking_attendee
   SET email_normalized = lower(trim(email))
 WHERE email_normalized IS NULL;

CREATE INDEX IF NOT EXISTS booking_attendee_email_normalized_idx
  ON booking_attendee (email_normalized);
