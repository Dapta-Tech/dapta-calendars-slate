-- See migrations/postgres/0030_booking_seated_backfill.sql for the rationale.
--
-- Every booking whose calendar event has more people on it than its booker
-- (more than one attendee, or any guest added afterwards) is shared. Rows
-- already marked are skipped.

UPDATE booking SET seated = 1
WHERE seated IS NULL
  AND id IN (
    SELECT booking_id FROM booking_attendee GROUP BY booking_id HAVING COUNT(*) > 1
    UNION
    SELECT booking_id FROM booking_guest
  );
