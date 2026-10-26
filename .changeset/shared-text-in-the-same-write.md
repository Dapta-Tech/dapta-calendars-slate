---
"@slate/db": patch
---

Every path that adds someone to a booking's one calendar event (a seat, v2
guests, the machine API's attendee) now writes the safe shared text (the
event's name, no description) in the same transaction as the newcomer and the
shared mark, when the booking was not shared yet; the richer shared render
still follows the commit. A booking whose event type was deleted (bookings
outlive it) gets a neutral title in its host's language instead (`Meeting`,
`Reunión`), never the stored one, which may be the first invitee's own.
Since the newcomer always comes with a shared text, the event is written out
to them even when the render after the commit fails: `addGuestsToBooking` and
`addAttendeeToBooking` no longer return `shared`, and a seat taken on a group
slot always reports `seatTaken`. `loadBookingForCalendarWrite` reads who is on
the event before its text, so a calendar write never pairs a newcomer with the
first invitee's own title or description, even when it runs between the
commit and the render.
