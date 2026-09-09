---
"@slate/db": minor
"@slate/types": minor
"@slate/shared": minor
---

Add a per-event-type duplicate-booking guard, off by default. When a host
switches it on, one normalized email address may hold at most one upcoming
booking on that event; both public write paths honour it, and host-initiated and
API-key writes are exempt. A blocked booker gets `409 DUPLICATE_BOOKING` with no
slot detail.
