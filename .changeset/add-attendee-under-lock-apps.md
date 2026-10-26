---
"@slate/api": patch
---

`POST /v1/machine/bookings/:uid/attendees` answers 410 for a booking that is
cancelled or no longer active and 422 `LIMIT_EXCEEDED` for one that holds 30
people already (or its event's seats, when more); nothing is written in either
case. An address already on the booking answers 201 and changes nothing. Once
a new attendee is on the booking, the calendar event's rewrite is queued for
them. Adding v2 guests and taking a seat on a group slot (the booking page, v1,
v2, MCP and the host's own new booking) queue it the same way, now also when
the shared render after the commit did not land: the newcomer came with the
shared text in the same write, and a newcomer left off then was never written
out, since a retry changes nothing. The OpenAPI document lists the new answers,
and the v2 guests route's 422 now says what it is: `LIMIT_EXCEEDED`, the
booking holding 30 people in all (or its event's seats, when more).
