---
'@slate/db': patch
---

Index `slot_reservation.uid`.

Every lookup of a soft hold keys on the uid — the release delete (`releaseSlot`),
the hold-validation read, and the hold-consumption deletes on the booking path —
and the table carried indexes only on `release_at_ms` and on
`(event_type_id, member_id, slot_start_ms)`. Each uid lookup was a sequential scan.

The scan is pre-existing. What changed is that one of those paths is now reachable
anonymously, at rate-limiter speed, from `POST /v1/reservations/release`, which
turns a per-release scan into a cost multiplier. It is not a correctness problem:
the table stays small, since holds are capped per host member and `reserveSlot`
sweeps expired rows on every call.

Additive and index-only — a numbered migration in both dialects, no column,
table or constraint change, and no change to reservation semantics. The index is
deliberately NOT unique: `uid` is not asserted unique today, and making it so
would be a separate, non-additive decision.
