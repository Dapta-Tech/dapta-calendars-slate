-- Booking limits: how many bookings of an event type, and how many minutes of
-- them, one day and one week may hold (additive + SAFE).
--
--   - event_type.max_bookings_per_day / max_bookings_per_week: a day, or a week
--     (Monday to Sunday), in the schedule's time zone, holds at most this many
--     accepted or pending bookings of the event; a seated time counts once.
--   - event_type.max_minutes_per_day / max_minutes_per_week: the same, counted
--     in minutes of those bookings.
--   Every slot read, hold, booking and reschedule check applies them, and the
--   locked write counts again. NULL = no limit: every existing event offers
--   exactly the times it offers today.
--
-- Migration safety: four ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill: every existing event keeps NULL.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS max_bookings_per_day INTEGER;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS max_bookings_per_week INTEGER;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS max_minutes_per_day INTEGER;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS max_minutes_per_week INTEGER;

RESET lock_timeout;
