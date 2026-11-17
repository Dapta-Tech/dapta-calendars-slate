-- See migrations/postgres/0042_event_type_booking_limits.sql for the rationale.
--
-- Nullable, no default: every existing event keeps no limit. One transaction:
-- the runner executes the file as a script, where each statement would commit
-- on its own, so a crash after the first ALTER would leave "duplicate column"
-- on every retry. Together, the four land or none does.
BEGIN;

ALTER TABLE event_type ADD COLUMN max_bookings_per_day INTEGER;
ALTER TABLE event_type ADD COLUMN max_bookings_per_week INTEGER;
ALTER TABLE event_type ADD COLUMN max_minutes_per_day INTEGER;
ALTER TABLE event_type ADD COLUMN max_minutes_per_week INTEGER;

COMMIT;
