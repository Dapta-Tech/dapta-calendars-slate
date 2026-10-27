---
"@slate/db": minor
"@slate/engine": minor
"@slate/types": minor
"@slate/shared": minor
---

An event type can limit how far ahead it is booked: "invitees can book up to N calendar days ahead". A new nullable column, `event_type.booking_window_days` (Postgres migration 0035, SQLite 0034, additive, bounded by `lock_timeout`), holds N from 1 to 730; NULL, every existing event, keeps today's behavior (no limit).

The days are counted the way cal.com counts "calendar days into the future": today is day 0 and the last bookable day is today plus N, both read in the time zone of the schedule the times come from, whatever the hour. A day whose midnight a DST change skips starts at the transition, so it is neither shortened nor lengthened. The limit is applied inside `computeSlots`, next to the minimum notice, so it holds everywhere the minimum notice does: every slot read (public pages, `/v1` and `/v2` slots, the MCP slot tools), and every hold, booking and reschedule check, personal and team. A time past the window answers exactly what a time that is not offered answers. A host's own booking made outside availability (the dashboard's "any time", and the API-key route `POST /v1/machine/bookings`) is not limited, as it is not by the minimum notice.

`@slate/engine` adds `bookingWindowEnd` and the `bookingWindowDays` input of `computeSlots`; `@slate/types` adds `bookingWindowDays` to the event type input and `MAX_BOOKING_WINDOW_DAYS`; `@slate/db` reads, writes and applies it; `@slate/shared` adds the EN and ES copy under `admin.eventTypes.bookingWindow`.
