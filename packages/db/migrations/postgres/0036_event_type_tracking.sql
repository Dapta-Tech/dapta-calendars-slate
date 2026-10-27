-- Tracking and pixels per event type (additive + SAFE).
--
--   - event_type.tracking: the ids of the third-party tags the event's public
--     booking page loads, `{ gtmId, metaPixelId, posthogKey, posthogHost,
--     hubspotTrackingId }`, each optional (`eventTrackingSchema` in
--     @slate/types). Each tag loads only when its id is set, and only on this
--     event's booking page, never in the dashboard. NULL = none: every
--     existing event's booking page makes no request it does not make today.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. No backfill: every existing event keeps NULL.
SET lock_timeout = '5s';

ALTER TABLE event_type ADD COLUMN IF NOT EXISTS tracking JSONB;

RESET lock_timeout;
