---
"@slate/api": patch
"@slate/web": patch
---

A booking's page in the dashboard (`/admin/bookings/<uid>`) shows who booked
and what they answered, as the host's copy of the booking email lists them:
name, email, phone, the other guests, the event's questions with their answers
in its order, then the notes. `GET /v1/host/bookings/:uid` answers `guest`,
built by the same code as that email (`bookingDetails`), with `?locale=en|es`
for the words it adds (Yes/No, Notes). Only the booking's host (the member the
bookings list shows it to) and the co-hosts assigned to it, the people that
email goes to, get it; anyone else in the account reads the booking with
`guest: null`. Visitor input renders as text, never markup or a link.
