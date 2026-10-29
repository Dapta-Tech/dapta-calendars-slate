---
"@slate/types": minor
"@slate/db": minor
"@slate/engine": minor
"@slate/shared": major
---

Bookings keep the campaign they came from, and the redirect after booking can carry the booking's details to the host's page.

- `@slate/types`: `BOOKING_UTM_KEYS` (the five `utm_*`), `bookingUtmSchema`, `normalizeBookingUtm` (keeps those keys only, trimmed, drops blank, over-long and control-character values, never refuses), `MAX_BOOKING_UTM_VALUE`; `utm` on the create-booking input (taken as sent, cleaned) and on `BookingView`; `SUCCESS_REDIRECT_DATA_MODES` (`event`, `event_and_invitee`) and `successRedirectData` on the event type input.
- `@slate/db`: new nullable columns `booking.utm` and `event_type.success_redirect_data` (Postgres migration 0037, `JSONB` and `TEXT`; SQLite 0036, `TEXT`; additive, bounded by `lock_timeout`, no backfill). `setBookingUtm` (never overwrites, so a group booking keeps its first seat's campaign), `getBookingUtm`, `getBookingSuccessRedirect` (the URL, the mode and the event type's own slug and name); event types read and write `successRedirectData`. `getBookingSuccessRedirectUrl` stays.
- `@slate/engine`: `bookingRedirectUrl(url, mode, details)`, pure: the event type, start, end, status, host and UTMs for `event`, plus the invitee's name and email for `event_and_invitee`, never the answers or the booking uid; parameters already on the host's address win; an address that would outgrow the cap goes as typed. `hasControlCharacter` is exported, so the UTM cleaning in `@slate/types` uses the same rule as the redirect address.
- `@slate/shared`: EN and ES copy for the redirect data choice (required `BookingMessages` members, hence major).
