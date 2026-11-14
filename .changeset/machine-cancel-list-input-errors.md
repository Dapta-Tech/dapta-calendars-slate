---
"@slate/api": patch
---

Invalid input on the machine cancel route and on both bookings lists answers a
400 that names the field, instead of a 500 or a silently wrong answer.

- `POST /v1/machine/bookings/:uid/cancel` with an `Idempotency-Key` over 200
  characters answers 400 (`Idempotency-Key: ...`), as bookings and reschedules
  already do. The booking is left as it was.
- `GET /v1/machine/bookings` and `GET /v1/host/bookings` refuse a `from` or `to`
  that is not a date (`from: Invalid date`) and a `limit` that is not an integer
  (`limit: Expected an integer`). A bad date used to read as no bound at all and
  return an empty list; a bad or repeated `limit` reached the database and
  answered 500. Any date the server could read before is still accepted, an
  empty value still means "not given", and an out-of-range `limit` is still
  clamped to 1..200.
