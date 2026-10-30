-- The .ics SEQUENCE counter of a meeting (additive + SAFE).
--
--   - booking.ics_sequence: how many changes (moves, cancellations, a
--     confirmation after a move) dCal has sent this meeting's .ics for. Kept on
--     the FIRST booking of a reschedule chain, the uid the invitee's calendar
--     knows the meeting by, and bumped atomically when each change is queued, so
--     every later .ics outranks the one before it. 0 = no change sent yet, which
--     every existing booking starts from.
--
-- Migration safety: one ADD COLUMN with a constant default: catalog-only on
-- Postgres 11+ (no rewrite, no scan), bounded by lock_timeout so a long
-- transaction makes the boot fail fast and retry. No backfill.
SET lock_timeout = '5s';

ALTER TABLE booking ADD COLUMN IF NOT EXISTS ics_sequence INTEGER NOT NULL DEFAULT 0;

RESET lock_timeout;
