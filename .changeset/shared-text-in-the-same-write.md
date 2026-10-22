---
"@slate/db": patch
---

Every path that adds someone to a booking's one calendar event (a seat, v2
guests, the machine API's attendee) now writes the safe shared text (the
event's name, no description) in the same transaction as the newcomer and the
shared mark, when the booking was not shared yet; the richer shared render
still follows the commit. `loadBookingForCalendarWrite` reads who is on the
event before its text, so a calendar write never pairs a newcomer with the
first invitee's own title or description, even when it runs between the
commit and the render.
