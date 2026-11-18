---
'@slate/api': patch
---

`GET /v1/host/bookings` and `GET /v1/machine/bookings` answer a 400 naming `status` when it is repeated or is not one of `accepted`, `pending`, `cancelled` or `rejected`, instead of a 500 (a repeated value reached SQL as an array). A repeated `cursor` is refused the same way (it used to silently restart at page one), and the host list now honors `cursor` (it returned `nextCursor` but ignored it). The OpenAPI `status` parameter declares the four values. An empty `status` still means not given, and a valid one still filters.
