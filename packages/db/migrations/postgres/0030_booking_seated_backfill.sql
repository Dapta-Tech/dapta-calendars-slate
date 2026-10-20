-- Mark the group slots that already exist as shared: `booking.seated = 1`
-- (the column is added by 0029_calendar_templates.sql) on every booking that
-- already holds more than one attendee. A slot shared by seats looks like that
-- whether or not its event type has seats today, and a row cannot tell a
-- seat-taker from a guest the booker brought, so both are marked. Marking a
-- booker's own guests too only keeps one person's data out of their event's
-- calendar title and description, which is the safe side. From now on the
-- seat path marks a booking itself, in the same transaction as the seat.
--
-- Migration safety: a file of its own, so it runs in its own transaction after
-- 0029's ALTER TABLEs have committed; no ACCESS EXCLUSIVE lock is held while it
-- runs. The UPDATE takes ROW EXCLUSIVE on `booking` (reads and writes go on)
-- and row locks only on the bookings it marks, found by one grouped read of
-- `booking_attendee`; rows already marked are skipped, so it is cheap to run
-- again. lock_timeout bounds the wait for any of those row locks, so a booking
-- held by a long transaction makes the boot fail fast and retry.
SET lock_timeout = '5s';

UPDATE booking b SET seated = 1
FROM (SELECT booking_id FROM booking_attendee GROUP BY booking_id HAVING COUNT(*) > 1) a
WHERE b.id = a.booking_id AND b.seated IS NULL;

RESET lock_timeout;
