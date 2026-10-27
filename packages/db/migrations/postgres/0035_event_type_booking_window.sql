-- Booking window: a limit on how far ahead an event type can be booked
-- (additive + SAFE).
--
--   - event_type.booking_window_days: invitees may book up to this many
--     calendar days ahead, today being day 0, counted in the schedule's time
--     zone. Every slot read, hold, booking and reschedule check applies it,
--     wherever the minimum notice applies. NULL = no limit: every existing
--     event offers exactly the times it offers today.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill: every existing event keeps NULL.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS booking_window_days INTEGER;

RESET lock_timeout;
