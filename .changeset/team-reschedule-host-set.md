---
"@slate/db": minor
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
pending booking holds its slot.

Adds `getBookingRescheduleAvailability`, the availability read behind the
manage page's reschedule picker for a team booking. The public team route
answers what an event offers a NEW invitee, and for round-robin that is the
union across hosts; a reschedule keeps the host it was assigned, so the picker
was offering times the write refused with `INVALID_SLOT`. The new read is
scoped to the booking's own assigned hosts and intersected, so the picker and
the write cannot disagree.

`isSlotBookable` takes an optional `hostScheduleId` so a team host's own
schedule (`event_type_host.schedule_id`) resolves the same way the team
availability projection resolves it. Omitted, it behaves exactly as before.

No schema change and no migration.
