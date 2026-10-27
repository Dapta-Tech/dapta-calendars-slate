---
"@slate/web": minor
"@slate/api": minor
---

The event type editor has a "Redirect after booking" field (personal and team events), checked as you leave it. After a booking lands, accepted or pending, the booking page sends the invitee to that URL; inside an inline embed it is the top window that moves, and when the browser does not allow that, the confirmation says where it was going with a Continue link. The public booking routes (`POST /v1/bookings` and `POST /v1/public/teams/{account}/{team}/bookings`) answer `successRedirectUrl` to the invitee who booked. `/v1` event types read and write it, and `/v2` lists it under the same name. See `event-redirect-after-booking.md` for the data side.
