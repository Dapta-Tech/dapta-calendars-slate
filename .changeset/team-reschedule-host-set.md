---
"@slate/db": minor
"@slate/types": minor
---

Make a reschedule answer to the host set the booking was created with.

`rescheduleBooking` validated the target and ran its transactional overlap
guard against `booking.host_member_id` alone. A collective booking assigns
every host — `createTeamBooking` writes a `booking_host` row per host and
guards overlap for all of them — so a manage-token holder could POST a move
that double-booked a co-host, one the create path would have refused. The
Postgres `booking_no_overlap` EXCLUDE constraint does not cover it, because a
co-host conflict is a different tuple, which left the app-level guard as the
only line. It now resolves the booking's whole assigned host set and applies
the bookability check, the external-calendar conflict check and the overlap
guard to every host, inside the one transaction, on both dialects. The guard
also matches the create-time one exactly: a member is busy whether they hold
the conflicting booking as its organizer or as an assigned co-host, and a
pending booking holds its slot. The insert guard and the move guard are now
one function, so they cannot drift apart again.

Adds `getBookingRescheduleAvailability`, the availability read behind the
manage page's reschedule picker for a team booking. The public team route
answers what an event offers a NEW invitee, and for round-robin that is the
union across hosts; a reschedule keeps the host it was assigned, so the picker
was offering times the write refused with `INVALID_SLOT`. The new read is
scoped to the booking's own assigned hosts and intersected, so the picker and
the write cannot disagree. It drops the booking being moved from its own
hosts' busy sets, exactly as the write does, so buffers around a booking no
longer stop it moving to the slot next door.

`isSlotBookable` now reads its busy set through `loadBusyForHost`, which is
the definition of busy the availability projections use — a member is busy for
a booking whether they hold it as its organizer or as an assigned co-host. Its
own query matched `host_member_id` only. It also takes an optional
`hostScheduleId`, so a team host's own `event_type_host.schedule_id` resolves
the way the team availability projection resolves it; omitted, it behaves
exactly as before. The v2 reschedule surface passes it too, so both reschedule
paths resolve a team host's hours the same way.

`@slate/types` gains `rescheduleAvailabilityQuerySchema` for the new read's
window, so an unparseable instant is a 400 rather than a `RangeError` out of
the slot engine.

No schema change and no migration.
