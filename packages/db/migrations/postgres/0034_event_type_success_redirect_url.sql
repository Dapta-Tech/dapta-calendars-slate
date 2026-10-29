-- Redirect after booking (additive + SAFE).
--
--   - event_type.success_redirect_url: where the booking page sends the invitee
--     once a booking is made, instead of leaving them on the confirmation. An
--     absolute https URL; the API refuses anything else before it is stored.
--     NULL = none: the confirmation stays on screen, exactly as before.
--     Reschedules and cancellations never read it.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill: every existing event keeps NULL.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS success_redirect_url TEXT;

RESET lock_timeout;
