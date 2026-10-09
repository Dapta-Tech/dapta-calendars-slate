# @slate/calendar

## 0.1.0

### Minor Changes

- ff2e458: Deliver the conferencing link: mint exactly one room per booking and resolve
  `{{meeting_url}}` when the mail is sent.

  A team booking used to request a conferencing link on every write destination,
  minting one room per host for a single meeting. Destinations are now ordered
  organizer-first, only the first requests a link, and co-hosts are written in a
  second pass carrying that URL — so every `booking_reference` row for a booking
  names the same room.

  `{{meeting_url}}` joins the template variables as the one value resolved at
  delivery rather than snapshotted at enqueue: it is minted later, by the calendar
  outbox row, so an enqueue-time snapshot can never contain it. A conferencing
  booking's confirmation and reschedule mail is made due slightly late and waits a
  bounded number of attempts for the link, then sends without it. A calendar
  failure costs the link, never the email and never the booking.

  The link now appears in the confirmation, reschedule and reminder mail for both
  the attendee and the host, in EN and ES, in the plain-text body and as a Join
  call-to-action in the branded HTML; the `.ics` carries it as `LOCATION` plus a
  `URL:` property. A reschedule persists a returned link only when it is non-null,
  so a backend that keeps the same room can no longer blank a good stored URL.

- 6016620: Location kind on the event type, snapshotted onto the booking.

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

### Patch Changes

- 22252c0: Carry the connected account's photo, and give a long description a ceiling.

  `CalendarSummary` and the discovery record gain an OPTIONAL `avatarUrl`, so a
  calendar backend that knows the connected account's photo can report it. It is
  stored on `connected_calendar` (additive, nullable, both dialects) and surfaces
  as `PublicProfile.member.connectedAvatarUrl` — beside the host's own
  `avatarUrl`, never merged into it: that column feeds the studio's input, and a
  sync landing there would turn a fallback into a saved value that outlives the
  connection. A backend that reports nothing behaves exactly as today.

  The booking page's copy gains `bookingPage.descriptionMore` / `descriptionLess`
  for the description clamp, and the studio gains
  `studio.photoFromConnectedAccount` — a host whose page is drawing the connected
  account's photo should be told where that face came from, and that uploading
  their own replaces it.

  `setConnectionAvatar` takes an `accountId`: it is a new write, and every
  repository write is account-scoped.

- 95b8e5f: Add the production-pilot calendar discovery, multi-calendar availability, and Cal-shaped booking lifecycle primitives.
