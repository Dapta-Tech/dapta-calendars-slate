---
"@slate/types": minor
---

Give `bookingViewSchema` an optional `hostMemberId`, so one booking shape covers
both public write paths. The team booking route used to answer a narrow
`{ uid, hostMemberId, manageUrl }` while the personal route answered a full
`BookingView`; it now returns the same `BookingView`, with `hostMemberId` — the
organizer its scheduling method resolved to — kept as an additive field.

Additive and optional: the personal path never sets it, and every response that
parsed against the schema before still parses.
