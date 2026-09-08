---
"@slate/engine": minor
"@slate/types": minor
"@slate/db": minor
"@slate/shared": minor
"@slate/calendar": minor
"@slate/config": minor
---

Location kind on the event type, snapshotted onto the booking.

An event type now has a **location kind** — `conferencing`, `in_person`, `phone`
or `custom` — with an optional detail, stored as `{ kind, detail? }` in the
existing `event_type.locations` column. **Zero migration for that column**: the
new `parseEventLocation` (in `@slate/engine`, pure and unit-tested) reads both
shapes, so already-saved rows keep working — the legacy conferencing literal
coerces to `{ kind: 'conferencing' }`, any other non-empty string to
`{ kind: 'custom', detail }`, and null stays null.

The kind is **snapshotted** onto each booking in a new nullable
`booking.location_kind` (additive, both dialects, migrations
`postgres/0013` + `sqlite/0012`). A snapshot rather than a lookup:
`booking.event_type_id` is nullable, and a host editing the event type later
must not retroactively rewrite what a past booking meant. `booking.location`
keeps holding the human detail; a booking with no kind (written before this
shipped) renders from that raw text exactly as it always did.

Both R15 breaches on the behavioural path are retired. The conferencing trigger
in the calendar seam is now `locationKind === 'conferencing'` instead of a
vendor literal compared against `booking.location`, and the shared i18n
catalogue no longer names a conferencing platform anywhere.

One legacy token remains, and deliberately: `LEGACY_CONFERENCING_VALUE` in
`@slate/engine` is the exact string already sitting in customer rows, and
`parseEventLocation` has to recognise it to read them. It is spelled once, is
never written again, and no longer triggers anything on its own — the migrations
back-fill it into `location_kind` and blank it out of `location`, so it stops
being rendered to humans too.

`CalendarProvider` gains an optional `conferencingLabel` so the running
deployment can name the platform it actually mints links on
(`CALENDAR_CONFERENCING_LABEL`, or an overlay's own value, which wins). It is a
HOST-facing affordance: the event-type editor reads it off the connections
response it already fetches (ADR 0008 — the web app still never imports
`@slate/calendar`). Invitee-facing surfaces — the public booking page, the
manage page, transactional email — stay generic in C1, so they cannot disagree
with each other; the link an invitee actually needs is C2's job. A bare fork
leaves the label null and shows generic wording everywhere, which is correct:
it has no conferencing to name.

`@slate/shared` gains `formatLocation` / `formatBookingLocation`, so the public
booking page, the manage page and the transactional email all render one Where
the same way, in EN and ES.
