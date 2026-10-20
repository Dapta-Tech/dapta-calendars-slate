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
-- already made keep the title and calendar event they have. The one backfill
-- marks every booking that already holds more than one attendee: a slot shared
-- by seats looks like that whether or not its event type has seats today, and
-- a row cannot tell a seat-taker from a guest the booker brought. Marking a
-- booker's own guests too only keeps one person's data out of their shared
-- event's text, which is the safe side.
--
-- Migration safety: four ADD COLUMNs, nullable, no default: catalog-only in
-- Postgres (no rewrite, no scan), no index. The brief ACCESS EXCLUSIVE lock on
-- `booking` (the hot table) is bounded by lock_timeout so a long transaction
-- makes the boot fail fast and retry rather than queue every booking behind it.
-- The backfill touches only bookings with more than one attendee, with the
-- same bound on its row locks.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS calendar_title_template TEXT;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS calendar_description_template TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS calendar_description TEXT;
ALTER TABLE booking ADD COLUMN IF NOT EXISTS seated INTEGER;

UPDATE booking SET seated = 1
WHERE seated IS NULL
  AND (SELECT COUNT(*) FROM booking_attendee a WHERE a.booking_id = booking.id) > 1;

RESET lock_timeout;
