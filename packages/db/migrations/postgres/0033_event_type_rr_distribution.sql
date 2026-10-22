-- How a round robin team event spreads its bookings (additive + SAFE).
--
--   - event_type.rr_distribution: 'availability' or 'equal'. NULL reads as
--     'availability', today's behavior: a time is offered when any host is free
--     and the booking goes to the free host with the highest priority, then the
--     lowest load. 'equal' counts only this event's bookings, hides a host's
--     times while they are 3 or more bookings ahead of the least-booked host,
--     and ignores priority (Calendly's "Optimize for equal distribution").
--     Only round robin reads it.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill: every existing event keeps NULL.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS rr_distribution TEXT;

RESET lock_timeout;
