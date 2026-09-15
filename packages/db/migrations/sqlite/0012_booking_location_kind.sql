-- Location kind, snapshotted onto the booking (additive + SAFE).
--
-- `event_type.locations` needs NO migration: it already holds JSON, and the
-- parse (engine/location.ts parseEventLocation) accepts both the legacy
-- free-text string and the new `{ kind, detail? }` object, so already-saved
-- rows keep working untouched.
--
-- `booking.location_kind` is the snapshot. A snapshot rather than a lookup
-- because `booking.event_type_id` is nullable AND a host editing the event type
-- later must not retroactively rewrite what a past booking meant.
-- NULL = a booking written before the kind existed: `booking.location` still
-- holds its raw string and the render falls back to it.
--
-- `booking.location` keeps holding the human detail (address, number, custom
-- label) and is unchanged EXCEPT for the legacy-token rows blanked by the
-- back-fill below; conferencing carries no detail, its link lives in
-- booking_reference.meeting_url.

ALTER TABLE booking ADD COLUMN location_kind TEXT;

-- Backfill the one legacy value that already meant "mint a meeting link".
-- Without this, a booking taken before this deploy and CONFIRMED after it (or
-- whose calendar write-out is still sitting in the outbox) would lose its link:
-- the trigger moved from booking.location to booking.location_kind. It also
-- stops that raw token being rendered to a human on those rows.
--
-- NOTE: unlike the rest of this repo's migrations, these two statements MUTATE
-- DATA. Rolling back to the previous image does not restore the blanked
-- `location` text, so rollback past this migration is forward-only.
UPDATE booking SET location_kind = 'conferencing'
 WHERE location_kind IS NULL AND location = 'google_meet';
UPDATE booking SET location = NULL
 WHERE location_kind = 'conferencing' AND location = 'google_meet';
