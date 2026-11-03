---
"@slate/engine": minor
"@slate/calendar": minor
"@slate/db": minor
"@slate/config": minor
"@slate/shared": minor
---

Repeating host events, a video link the calendar creates, and other people's
busy times (ADR 0012).

`@slate/engine`: `recurrence.ts`, the pure rule of a series: the dates of a
daily or weekly rule (every N, chosen weekdays, a count, a last date or no end)
at one wall-clock time in a zone across DST changes (a skipped local time is
read as calendars read it, RFC 5545), its RRULE (`rruleFor`), and the checks
that a rule is valid (`recurrenceProblem`).

`@slate/calendar`: the port can create ONE repeating event (`recurrence` on
create and update), change or cancel one date of it by its original start
(`occurrenceStartUtc`), say per connection what its backend can do
(`features`, read through `calendarFeatures`), and read other people's busy
times (`listAttendeeBusy`, unknown never free). All optional: a backend that
predates them keeps working and is never sent a series.

`@slate/db`: `host_event_series` (migration 0040 on Postgres, 0039 on SQLite,
additive) holds a series; its dates are host-event bookings linked by
`booking.recurring_event_id`, written 180 days ahead with every date checked
like a single event (`createHostEventSeries`), extended as time passes
(`extendHostEventSeries`), cancelled or moved from a date on
(`cancelHostEventSeries`, `moveHostEventSeries`). `hostEventOwnTime` counts a
date of a series written to the calendar as the host's own time there.
`bookingConflicts` and `holdConflicts` are exported for the series writes.

`@slate/config`: `CALENDAR_BACKEND_FEATURES` (optional) says what a generic
REST calendar backend can do beyond single events (`recurrence`,
`attendee-free-busy`).

`@slate/shared`: the copy for `check_attendee_availability`, for repeating
events on the Tools page and in the dashboard's bookings (the "Repeats" mark,
the rule, and which dates to cancel), in English and Spanish.
