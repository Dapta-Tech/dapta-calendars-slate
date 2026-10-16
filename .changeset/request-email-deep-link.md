---
'@slate/db': minor
'@slate/shared': minor
---

The host's "Confirm or decline" link opens that booking, even from a signed-out browser and whatever the bookings list holds.

- `@slate/shared`: `adminBookingPath(uid)` is now `/admin/bookings/<uid>`, the booking's own page, with the uid in the path where the server and the sign-in can see it (it was a fragment on the list, which the login lost and which only reached the first 200 rows). `legacyBookingHashUid(hash)` reads the uid out of a link an earlier email carried (`/admin/bookings#booking-<uid>`), so those mails still open their booking for a host who is signed in; one who is signed out lands on the bookings list after the login, since a fragment does not survive it.
- `@slate/db`: `getHostBooking(db, { accountId, uid })`, one booking in the host list's shape, inside the account; null for an unknown uid and for another account's alike.
