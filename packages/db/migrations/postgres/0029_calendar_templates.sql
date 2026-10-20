-- The calendar event's own title and description, as templates a host writes
-- per event type (`Meeting Felipe - {{name}}`), and the rendered body stored on
-- each booking (additive + SAFE).
--
--   - event_type.calendar_title_template: the title template. NULL = none: a
--     booking's title is the event's name, exactly as before.
--   - event_type.calendar_description_template: the description template.
--     NULL = none: the calendar event has no description, as before.
--   - booking.calendar_description: the body rendered for this booking when it
--     was placed (or last moved), like `booking.title` is rendered from the
--     title template. Every calendar write and both .ics files read it. NULL =
--     no description; '' = one this booking had, cleared since (a move then
--     clears it on the calendar too).
--   - booking.seated: 1 once someone took a seat on this booking, so people who
--     booked separately share its one calendar event. Its title and description
--     then never carry one invitee's data, even if the event type's seats are
--     turned off later. NULL = nobody took a seat.
--
-- NULL on every existing row, which reads as "no template" and "no
-- description": nothing changes for a host until they write one, and bookings
-- already made keep the title and calendar event they have. The group slots
-- that already exist are marked `seated` by the next migration
-- (0030_booking_seated_backfill.sql), on purpose in a file of its own.
--
-- Migration safety: four ADD COLUMNs, nullable, no default: catalog-only in
-- Postgres (no rewrite, no scan), no index. Each takes an ACCESS EXCLUSIVE
-- lock on its table, held until this file's transaction commits, so this file
-- does nothing else: no data is read or written while `booking` (the hot
-- table) is locked. lock_timeout bounds only the WAIT for that lock, so a long
-- transaction makes the boot fail fast and retry rather than queue every
-- booking behind it.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS calendar_title_template TEXT;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS calendar_description_template TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS calendar_description TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS seated INTEGER;

RESET lock_timeout;
