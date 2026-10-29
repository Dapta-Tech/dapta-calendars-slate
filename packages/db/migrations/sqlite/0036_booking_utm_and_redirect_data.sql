-- See migrations/postgres/0037_booking_utm_and_redirect_data.sql for the rationale.
--
-- Nullable, no default: every existing booking keeps no UTMs and every
-- existing event redirects to its address as typed.

ALTER TABLE booking ADD COLUMN utm TEXT;
ALTER TABLE event_type ADD COLUMN success_redirect_data TEXT;
