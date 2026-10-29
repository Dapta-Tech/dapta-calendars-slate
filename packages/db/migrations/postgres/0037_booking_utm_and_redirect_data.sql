-- UTMs on bookings and booking details on the redirect after booking
-- (additive + SAFE).
--
--   - booking.utm: the campaign the booking came from, `{ utm_source,
--     utm_medium, utm_campaign, utm_term, utm_content }`, each optional
--     (`bookingUtmSchema` in @slate/types). NULL = none, which is every
--     booking made before this and every booking from a page without UTMs.
--   - event_type.success_redirect_data: what the redirect after booking
--     carries to the host's page, 'event' or 'event_and_invitee'
--     (`SUCCESS_REDIRECT_DATA_MODES`). NULL = the address as typed, which is
--     what every existing event keeps.
--
-- Migration safety: two ADD COLUMNs, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill.
SET lock_timeout = '5s';

ALTER TABLE booking ADD COLUMN IF NOT EXISTS utm JSONB;
ALTER TABLE event_type ADD COLUMN IF NOT EXISTS success_redirect_data TEXT;

RESET lock_timeout;
