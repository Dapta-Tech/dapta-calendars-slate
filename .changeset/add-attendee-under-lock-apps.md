---
"@slate/api": patch
---

`POST /v1/machine/bookings/:uid/attendees` answers 410 for a booking that is
cancelled or no longer active and 422 `LIMIT_EXCEEDED` for one that holds 30
people already (or its event's seats, when more); nothing is written in either
case. An address already on the booking answers 201 and changes nothing. Once
a new attendee is on the booking and its calendar text is the shared one, the
calendar event's rewrite is queued for them, as adding v2 guests does. The
OpenAPI document lists the new answers.
