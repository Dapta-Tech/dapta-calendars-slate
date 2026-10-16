-- See migrations/postgres/0025_booking_locale.sql for the rationale.
--
-- Nullable, no default: every existing booking reads NULL, which keeps its
-- invitee mail in the host's language, exactly as before.

ALTER TABLE booking ADD COLUMN locale TEXT;
