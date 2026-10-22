-- Mark the shared bookings that already exist: `booking.seated = 1` (the
-- column is added by 0029_calendar_templates.sql) on every booking whose one
-- calendar event has more people on it than its booker: more than one
-- attendee (seat-takers, or extra attendees the booker named) or any guest
-- added afterwards. Each of them is a guest on the event, so its calendar
-- title and description must not carry the booker's own data. From now on a
-- booking is marked when it is written that way, when a seat is taken (in the
-- same transaction) and when guests are added.
--
-- Migration safety: a file of its own, so it runs in its own transaction after
-- 0029's ALTER TABLEs have committed; no ACCESS EXCLUSIVE lock is held while it
-- runs. The UPDATE takes ROW EXCLUSIVE on `booking` (reads and writes go on)
-- and row locks only on the bookings it marks, found by one grouped read of
-- `booking_attendee` and one of `booking_guest`; rows already marked are
-- skipped, so it is cheap to run
-- again. lock_timeout bounds the wait for any of those row locks, so a booking
-- held by a long transaction makes the boot fail fast and retry.
SET lock_timeout = '5s';

UPDATE booking b SET seated = 1
FROM (
  SELECT booking_id FROM booking_attendee GROUP BY booking_id HAVING COUNT(*) > 1
  UNION
  SELECT booking_id FROM booking_guest
) a
WHERE b.id = a.booking_id AND b.seated IS NULL;

RESET lock_timeout;
