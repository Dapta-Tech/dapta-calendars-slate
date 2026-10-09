# @slate/engine

## 0.1.0

### Minor Changes

- 03fd0e0: One-off invite links — a token a host mints over an event type they already have,
  pastes into one message to one intended invitee, and which dies the moment a booking
  is made against it (#69 / AB2, closing #110).

  **It is a grant, not a meeting.** The new `one_off_link` table holds which event type,
  the token, who minted it, when, and what consumed it. There is deliberately no duration,
  no availability and no title: an ad-hoc meeting that exists only as a link would be a
  second kind of bookable object, and that stays deferred at #69.

  **Like the duplicate-booking guard it ships beside, it is not a security control.**
  The per-IP rate limiter is. What a one-off link buys is that a link sent to one person
  cannot be forwarded and re-used a hundred times. It authenticates nobody.

  **It dies on booking, `pending` included, and a cancel never revives it.** A pending
  booking is a booking for this purpose — the link did its job the moment it produced
  one. Cancelling that booking leaves the link spent and the host mints another. That
  rule is asserted directly on both dialects, because it is the one a future refactor
  will get wrong.

  **The token is stored in clear, unique and re-readable**, which is the opposite of
  `booking.manage_token_hash` one table over. That inconsistency is the decision, made in
  [ADR 0003](docs/adr/0003-public-tokens-have-two-storage-policies.md): the host is this
  token's custodian rather than its recipient, so they copy it again hours or days after
  minting; presenting it reads no PII and mutates nothing that already exists. Because it
  is re-readable, revocation is real — the editor lists live links and can withdraw one,
  which the ADR makes a condition of the storage choice rather than a nicety.

  **Three public codes, three causes.** A consumed or revoked link answers `410`; a token
  that names nothing answers `404` with the same body any missing route gives, and says
  nothing about invite links existing at all; AB1's `409 DUPLICATE_BOOKING` is untouched.
  That split is what constrains the URL shape: a token carried as a query parameter on the
  normal public event URL could never answer `404`, because that page renders perfectly
  well without it. So the token is the whole address — `/booking/{token}`, a prefix no
  account can claim (it is on `RESERVED_PUBLIC_SLUGS`), outside the product prefixes so
  `?embed=1` and framing are unchanged, and carrying no account code at all, which is why
  the canonical-code 308 cannot fire on it. A link therefore survives its account claiming
  a vanity slug, because it stores an event-type id rather than a URL.

  **Both public write paths honour it** — `createBooking` and `createTeamBooking`. Host
  on-behalf and API-key writes are exempt exactly as they are for AB1, through the same
  mechanism rather than a second one: they never need a token and a token they happen to
  carry is neither validated nor burned.

  **`getEventType` and `getTeamEventType` gain an opt-in to see hidden event types.** That
  is the seam that makes the feature work at all — a one-off link only limits anything over
  an event hidden from the booking page, and reaching such an event is the whole point. The
  flag is set only after a token has been resolved and re-checked against that exact event
  type, and every existing caller keeps today's behaviour. Exemption is not a visibility
  widening: a hidden event stays as hidden to host and API-key writes as it is today.

  **A link over a still-public event limits nothing, and the editor says so** where the host
  mints it. Copy plus a condition, never a block — the host may have a reason.

  Migrations are additive and ship in both dialects (postgres `0021`, sqlite `0020`), adding
  one new table plus a unique index on the token.

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

- 0915e8f: Add onboarding's two gates: account qualification and per-host setup.

  Qualification is claimed write-once on the account and owed by owner/admin only;
  setup is owed by every active member with no published event type of their own,
  invited members included, and has no completion claim — it is satisfied by the
  event type existing, so a host who deletes their last one is guided again.

  Also corrects the "Get bookable" checklist. It measured the member's handle,
  which is auto-created for everyone, so it reported "bookable" to every host in
  the product while their public page rendered nothing. It now measures whether
  the host has at least one published event type.

  `@slate/shared` note: the `admin.home` keys `setupLinkTitle` / `setupLinkDesc`
  are replaced by `setupEventTitle` / `setupEventDesc` / `setupEventAction`. The
  old keys described a shareable link on a row that now measures published event
  types, so keeping the names would preserve the wrong claim in the catalogue.

### Patch Changes

- 5a7df37: Reserve `onboarding` as a public slug. It was the one top-level product path an account could still claim as its vanity slug, and with the inline embed's framing policy that is no longer only a routing collision: the account's booking page would be served from a path the framing rule reads as the dashboard, so it would answer `frame-ancestors 'self'` and its embed would render a blocked frame on every host site with no error anywhere.
