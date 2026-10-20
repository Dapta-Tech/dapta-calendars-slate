---
"@slate/db": patch
---

A seat on an existing group booking is counted and written inside the host's
locked transaction, so two concurrent seats can no longer over-fill the event,
and with `refuseHeld` another caller's hold over the time refuses the seat
there too (the hold being consumed is the booker's own and never counts). Every
seat a request asks for must fit (one booker plus guests on a slot with fewer
seats left is `SLOT_TAKEN`; more than the event's seats on an empty slot is
`INVALID`), and the group booking is read again under the lock, so a seat never
lands on a booking cancelled or moved in the meantime.
