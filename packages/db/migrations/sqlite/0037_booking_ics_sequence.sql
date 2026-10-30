-- See migrations/postgres/0038_booking_ics_sequence.sql for the rationale.
--
-- Constant default: every existing booking starts at 0, no change sent yet.

ALTER TABLE booking ADD COLUMN ics_sequence INTEGER NOT NULL DEFAULT 0;
