---
"@slate/api": patch
---

`POST /v1/machine/bookings/:uid/attendees` answers 400 for a blank or
non-text attendee name or address (spaces only included), and for any
address the data layer refuses. `POST /v2/bookings/:uid/guests` answers 400
for an address the data layer refuses. The v2 booking response and the v2
create path compare addresses with `normalizeAttendeeEmail`, the normalizer
every count of a booking's people uses.
