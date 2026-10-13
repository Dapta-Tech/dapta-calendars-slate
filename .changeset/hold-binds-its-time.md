---
"@slate/db": patch
---

A booking that presents a hold (`reservationUid`) now consumes it only when the
hold is for the same host, event type and start: any other hold answers
`RESERVATION_EXPIRED`, as a missing or expired one does, and is left in place.
A matching hold stands in for the offered-time check, so a hold matched by uid
alone let any live hold book any time on any event.
