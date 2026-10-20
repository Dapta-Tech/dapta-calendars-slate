---
"@slate/db": patch
---

A seat on an existing group booking is counted and written inside the host's
locked transaction, so two concurrent seats can no longer over-fill the event
by one, and with `refuseHeld` another caller's hold over the time refuses the
seat there too (the hold being consumed is the booker's own and never counts).
