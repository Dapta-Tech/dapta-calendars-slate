-- See migrations/postgres/0029_calendar_templates.sql for the rationale.
--
-- Nullable, no default: every existing event type reads as having no
-- template and every existing booking as having no calendar description.
-- The existing group slots are marked by 0029_booking_seated_backfill.sql.

ALTER TABLE event_type ADD COLUMN calendar_title_template TEXT;
ALTER TABLE event_type ADD COLUMN calendar_description_template TEXT;
ALTER TABLE booking ADD COLUMN calendar_description TEXT;
ALTER TABLE booking ADD COLUMN seated INTEGER;
