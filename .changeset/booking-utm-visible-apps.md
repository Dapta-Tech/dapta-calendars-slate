---
'@slate/web': minor
'@slate/api': minor
---

Hosts see the campaign each booking came from, its `utm_*`, wherever they read one booking.

- Dashboard: a booking's page shows a Campaign block with each `utm_*` key and value when the booking has any (nothing when it has none), and every row of the bookings list now opens that page.
- `GET /v1/host/bookings/:uid` answers `utm`, the stored campaign or null. The list stays as it was.
- `GET /v2/bookings/{uid}` (and every `/v2` booking response) answers `utm`, the stored campaign or null, behind the same `bookings:read` scope and event-type allowlist. The OpenAPI document and `API-CONTRACT.md` list it.
- MCP `get_booking` answers `invitee_supplied.utm`, cleaned like the rest of `invitee_supplied` (anyone can type a `utm_*` on an address), or null. `list_bookings` stays minimal.
- Every booking webhook (`booking.created`, `booking.confirmed`, `booking.rescheduled`, `booking.cancelled`) carries `utm` in its `data` when the booking has a campaign, and leaves the key out when it has none, as `booking.created` already did, so existing subscribers see no change.
