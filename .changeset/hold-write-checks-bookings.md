---
"@slate/db": minor
---

A soft hold is no longer placed on a booked time. `insertHoldGuarded` (and so
`reserveSlot`) checks the host's bookings again inside its locked transaction,
so a booking committed after the availability read and before the hold's lock
refuses the hold (`INVALID_SLOT`) instead of leaving its holder to learn at
booking time. A group event keeps its rule: its own booking at that start
blocks a hold only once its seats are taken.
