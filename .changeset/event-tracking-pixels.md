---
"@slate/db": minor
"@slate/types": minor
"@slate/shared": major
---

An event type can load the host's own tracking on its public booking page, the four tags dForms loads per form: Google Tag Manager, Meta Pixel, a PostHog project of the host's own and HubSpot's tracking code. A new nullable column, `event_type.tracking` (Postgres migration 0036 `JSONB`, SQLite 0035 `TEXT`, additive, bounded by `lock_timeout`), holds `{ gtmId, metaPixelId, posthogKey, posthogHost, hubspotTrackingId }`; NULL, every existing event, loads nothing.

Ids are trimmed, blank ones left out, and none left is NULL; an id may hold only letters, digits, `-` and `_` (every vendor's ids fit), and the PostHog host must be an https origin. Reads apply the same checks, so a value written past the API is dropped, never served. `@slate/types` adds `eventTrackingSchema`, `normalizeEventTracking`, `EVENT_TRACKING_KEYS` and the length caps, and `tracking` on the event type input, the public profile and team profile listings and the availability response; `@slate/db` reads and writes it and returns it on those reads; `@slate/shared` adds the EN and ES copy under `admin.eventTypes.tracking` (a required `BookingMessages` member, hence major).
