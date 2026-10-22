---
"@slate/db": patch
---

`addAttendeeToBooking` (the machine API's add-attendee) runs the same flow as
adding v2 guests: the attendee and the mark that the booking is now shared land
together under the booking's row lock, after its status is read again there,
so a v2 move never copies the attendee without the mark and a cancelled or
moved booking never gains one (`GONE`). The calendar text is then rendered as
shared, or reset to the event's name, so the event never carries the first
invitee's own data once someone else is on it; `shared: false` says neither
landed. Like guests, an address already on the booking is not written again
(`added: false`), and a booking takes at most `MACHINE_ATTENDEE_LIMIT` (30)
people in all, or its event's seats when those are more (`LIMIT_EXCEEDED`),
each address counted once wherever it is listed.
It now lives beside `addGuestsToBooking` in the same module.
