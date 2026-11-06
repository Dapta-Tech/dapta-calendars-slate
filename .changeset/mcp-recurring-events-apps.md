---
"@slate/api": minor
"@slate/web": minor
---

`@slate/api`: `create_event` takes `recurrence` (one series on the host's
calendar, one invitation; every date a dCal booking, checked and reported by
date; `skip_conflicting_dates`) and returns the video link the calendar
creates (`video`). `cancel_booking` and `reschedule_booking` take `scope`
(`this`, `this_and_following`, `series`) for a date of a series. New read-only
tool `check_attendee_availability` (19 tools): when the host and up to 20
people are free, unknown calendars named and never read as free. A job extends
every series' dates each hour. A calendar connection that cannot hold a
series answers `RECURRENCE_UNSUPPORTED`; one that cannot create a room,
`VIDEO_UNSUPPORTED`. The host cancel route takes the same `scope`.

`@slate/web`: the bookings list marks a date of a repeating event, its page
says how it repeats, and Cancel asks which dates (this one, this and later,
every date not started). The Tools page lists the new tool.
