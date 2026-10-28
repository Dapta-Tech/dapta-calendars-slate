-- See migrations/postgres/0035_event_type_booking_window.sql for the rationale.
--
-- Nullable, no default: every existing event keeps no limit.

ALTER TABLE event_type ADD COLUMN booking_window_days INTEGER;
