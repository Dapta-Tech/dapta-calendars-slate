---
"@slate/notifications": minor
"@slate/calendar": minor
"@slate/db": minor
---

Deliver the conferencing link: mint exactly one room per booking and resolve
`{{meeting_url}}` when the mail is sent.

A team booking used to request a conferencing link on every write destination,
minting one room per host for a single meeting. Destinations are now ordered
organizer-first, only the first requests a link, and co-hosts are written in a
second pass carrying that URL — so every `booking_reference` row for a booking
names the same room.

`{{meeting_url}}` joins the template variables as the one value resolved at
delivery rather than snapshotted at enqueue: it is minted later, by the calendar
outbox row, so an enqueue-time snapshot can never contain it. A conferencing
booking's confirmation and reschedule mail is made due slightly late and waits a
bounded number of attempts for the link, then sends without it. A calendar
failure costs the link, never the email and never the booking.

The link now appears in the confirmation, reschedule and reminder mail for both
the attendee and the host, in EN and ES, in the plain-text body and as a Join
call-to-action in the branded HTML; the `.ics` carries it as `LOCATION` plus a
`URL:` property. A reschedule persists a returned link only when it is non-null,
so a backend that keeps the same room can no longer blank a good stored URL.
