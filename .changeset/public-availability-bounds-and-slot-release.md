---
"@slate/db": minor
"@slate/types": minor
---

Bound the public team availability window, and give a soft hold back.

`@slate/types` gains `MAX_AVAILABILITY_WINDOW_DAYS` / `MAX_AVAILABILITY_WINDOW_MS`
and `clampAvailabilityWindow()` — one definition of the 60-day cap that every
availability path now shares, instead of a `60 * 86_400_000` literal repeated at
each site and missing entirely from the team path. It also gains
`teamAvailabilityQuerySchema`, so the unauthenticated
`GET /v1/public/teams/{code}/{team}/availability` parses its query the way the
personal route always has: an unparseable `from` is a 400 rather than a `NaN`
that travels into the slot engine, and the window is clamped rather than
generated across whatever range the caller named.

`@slate/db` gains `releaseSlot()`, the counterpart `reserveSlot()` never had.
The reservation uid is the authorisation — it is the only thing the holder has
that a visitor naming a slot does not — and the release is deliberately total:
a uid that names nothing, a hold that already expired, and a hold the booking
write already consumed all take the same silent path, so it is never an oracle
for whether a hold exists and cannot read as a failure when it races a booking
that succeeded. It deletes from `slot_reservation` only and can never reach a
confirmed booking. `releaseReservation()` is deprecated in its favour and now
delegates to it.

`@slate/types` also gains `releaseSlotSchema` for the new
`POST /v1/reservations/release` route. No schema change, no migration.
