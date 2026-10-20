-- See migrations/postgres/0030_booking_seated_backfill.sql for the rationale.
--
-- Every booking that already holds more than one attendee is a shared slot
-- (or a booker with a guest, marked too: the safe side). Rows already marked
-- are skipped.

UPDATE booking SET seated = 1
WHERE seated IS NULL
  AND id IN (SELECT booking_id FROM booking_attendee GROUP BY booking_id HAVING COUNT(*) > 1);
