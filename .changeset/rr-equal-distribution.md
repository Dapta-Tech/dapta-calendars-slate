---
"@slate/db": minor
"@slate/engine": minor
"@slate/types": minor
"@slate/shared": minor
---

Round robin team events can choose how bookings are spread, the choice Calendly calls "Optimize for availability" and "Optimize for equal distribution". A new nullable column, `event_type.rr_distribution` (Postgres migration 0033, SQLite 0032, additive, bounded by `lock_timeout`), holds `'availability'` or `'equal'`; NULL, every existing event, keeps today's behavior.

With `'equal'`, only this event's accepted bookings count, a host 3 or more bookings ahead of the least-booked host offers no times and takes no booking until the others catch up, and the booking goes to the free host with the fewest bookings of this event, then the least recently booked; priority and weight do not take part. Hosts whose configuration cannot offer times (an invited member with no schedule yet) do not set the floor, so they never hold the team back. Only round robin reads the setting.

`@slate/engine` adds `selectEqualHost`, `hostsAheadOfEqualShare` and `EQUAL_DISTRIBUTION_LEAD`; `@slate/types` adds `rrDistribution` to the event type input; `@slate/shared` adds the EN and ES copy under `scheduling`.
