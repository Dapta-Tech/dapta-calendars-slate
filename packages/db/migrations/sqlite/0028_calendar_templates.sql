-- See migrations/postgres/0029_calendar_templates.sql for the rationale.
--
-- Nullable, no default: every existing event type reads as having no
-- template and every existing booking as having no calendar description.
-- The backfill marks every booking that already holds more than one
-- attendee (shared slots, and to be safe a booker's own guests).

ALTER TABLE event_type ADD COLUMN calendar_title_template TEXT;
ALTER TABLE event_type ADD COLUMN calendar_description_template TEXT;
ALTER TABLE booking ADD COLUMN calendar_description TEXT;
ALTER TABLE booking ADD COLUMN seated INTEGER;

UPDATE booking SET seated = 1
WHERE seated IS NULL
  AND (SELECT COUNT(*) FROM booking_attendee a WHERE a.booking_id = booking.id) > 1;
