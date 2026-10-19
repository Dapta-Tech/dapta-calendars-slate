---
"@slate/db": patch
---

`declineBooking` now writes only while the booking is still pending, as
`confirmBooking` already did: a confirmation that lands between its read and its
write is no longer overwritten into a rejection, and it answers `GONE` instead.
