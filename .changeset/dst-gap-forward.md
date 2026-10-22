---
"@slate/engine": patch
---

A wall-clock time that falls in a daylight-saving change now lands where its
doc comment always said, in every zone. A time in a spring-forward gap (it
never happens on the zone's clock) resolves forward to the transition, the
first valid instant after the gap. Before, zones west of UTC resolved it
backward by the gap's length, and zones at or east of UTC (Europe/London,
Europe/Berlin) forward by it. A time in a fall-back overlap (it happens twice)
resolves to its first occurrence; zones at or east of UTC got the second one.

Both ends of a block move with it, on transition days only:

- America/Santiago, where 2026-09-06 skips from 00:00 to 01:00: Sunday hours
  from 00:00 start at 01:00 -03 instead of offering Saturday 23:00 -04, and
  Saturday hours to 24:00 now keep their 23:00 hour.
- America/New_York, 2026-03-08: hours from 02:00 start at 03:00 EDT, not
  01:00 EST; hours to 02:30 end at the transition (gaining 01:30 EST); hours
  wholly inside 02:00 to 03:00 offer nothing that day (they offered 01:00 EST).
- Europe/Berlin, 2026-03-29: hours to 02:30 end at the transition, 03:00
  CEST, where they ran to 03:30 CEST. At or east of UTC, hours that end
  inside a gap lose the time past the transition they used to get.
- Europe/Berlin, 2026-10-25, where 02:00 to 03:00 happens twice: hours from
  02:00 start at 02:00 CEST, gaining an hour, and hours to 02:30 end at the
  first 02:30, losing an hour. West of UTC, block ends in an overlap already
  worked this way.

Times outside a transition do not change (checked every 15 minutes over 2024
to 2026 in nine zones). Slot generation and booking validation share the one
projection, so they agree on transition days; with 30-minute slots, the old
Santiago Saturday 23:00 offer was refused by the booking check. Bookings
already made keep their times.
