# @slate/db

## 0.1.0

### Minor Changes

- a0f172d: Scope booking idempotency keys to their account. The replay lookup now filters
  on the booking's account, and the stored key is namespaced by account so the
  column's global uniqueness cannot be claimed across tenants. `createBookingSchema`
  no longer carries `idempotencyKey`: the unauthenticated booking payload cannot
  set one, and the authenticated surfaces pass it to the booking service as
  caller-supplied context instead.

  Ships a data-only migration in both dialects that namespaces keys already
  stored, so retries against a key from before the upgrade keep replaying and no
  pre-existing key stays reserved across tenants. No column, index or constraint
  changes.

- 327819e: A `CrmProvider` port, encrypted per-account credentials, and the CRM write-out

  `@slate/crm` is a new package: the `CrmProvider` port plus a HubSpot adapter,
  selected by `CRM_PROVIDER` (`disabled` by default). It names its vendor on
  purpose — ADR 0001 carves CRM out of R15, which governs calendar vendors only —
  and it is pure HTTP: the token arrives per call, so the adapter never holds a
  credential and never sees an encryption key. Errors are typed because the retry
  decision depends on them: `CrmAuthError` is terminal and carries the missing
  scope names as a list, `CrmPropertyError` is recoverable once, everything else
  takes the outbox's backoff.

  `@slate/db` gains the first symmetric encryption in the repo. `crypto.ts`
  implements an AES-256-GCM envelope (`v1.<iv>.<tag>.<ciphertext>`) whose
  additional authenticated data binds it to `(account, provider)`, so a ciphertext
  lifted from one account's row cannot be opened in another's. `integrations.ts`
  owns the new `account_integration` table behind it, and is shaped so a
  credential can only leave through `resolveProviderToken`: the status type it
  returns to callers has no cipher field at all. Disconnecting is a soft delete —
  the credential is scrubbed and the row's id survives, because
  `booking_reference.destination` points at that id and a new one would turn the
  first cancellation after a reconnect into a duplicate meeting.
  `claimBookingDestination` takes an optional reference type so the CRM write-out
  reuses the existing no-duplicates guard rather than growing a second one.

  `@slate/types` gains the connect contract, deliberately one-directional: the
  token is described going in and nowhere coming back. `@slate/shared` gains a
  `crm` message block in `en` and `es` for the few strings a host reads inside
  their CRM record. `@slate/config` gains `CRM_PROVIDER`,
  `INTEGRATION_ENCRYPTION_KEY`, `HUBSPOT_PRIVATE_APP_TOKEN` and
  `CRM_HTTP_TIMEOUT_MS`, all optional — a bare fork sets nothing, enqueues
  nothing, and needs no key to boot.

  Additive migration in both dialects. No behaviour changes for a deployment that
  leaves `CRM_PROVIDER` unset.

- 7c38767: Map intake questions onto CRM contact properties, per event type.

  A host wires each question — plus the attendee's phone, notes, time zone and
  language, and a closed catalog of event metadata — onto contact properties that
  already exist in the connected portal. Nothing here creates a property: the
  picker offers only what the portal has, which is what keeps the free tier's
  custom-property cap out of this feature. One source may feed several properties;
  each property is claimed by at most one source.

  A mapped answer OVERWRITES the property on every accepted booking; identity
  never does (ADR 0005). Delivery refines the CRM write-out in exactly one place:
  a contact the CRM already knows is PATCHed with the mapped properties and never
  its identity, and a contact it does not know is created with identity plus the
  mapping in the same call. Everything else about the write-out is unchanged —
  same outbox row, same idempotency, same meeting engagement, and every answer
  still renders in the meeting body whether or not it is mapped.

  The picker is filtered to type-compatible properties that are not archived,
  calculated, hidden or read-only, and the server refuses an incompatible pair on
  save so a stale editor cannot store a mapping that would deliver nothing. An
  orphaned mapping — one whose question was deleted or renamed — is flagged and
  dropped rather than refused, so an ordinary question edit never blocks the save.
  The list is fetched through the port and cached five minutes per account, with
  an explicit Refresh that is throttled per account and invalidated whenever a
  credential is connected or disconnected. Enumeration options auto-match on
  normalized values, with the mismatch named at configure time and the property
  omitted at delivery rather than sent and rejected. A thin EN/ES auto-map
  suggests and never saves.

  Storage is additive: a nullable `crm_property_mappings` JSON column on
  `event_type` in both dialects, NULL meaning never-configured, which is what
  every existing event type reads as and delivers as. `booking_attendee.language`
  is now persisted — the booking contract has always accepted it and this layer
  dropped it, so a mapping onto it could never have delivered anything.

  Mapped properties are best-effort and the booking is not: the contact write
  sheds them on any 400 the provider returns, bounded and ending in a minimal
  attempt, so a portal-side validation rule can never cost a booking its CRM
  record. A 429 or 5xx still takes the outbox's backoff.

  `CRM_API_BASE_URL` is new and defaults to the vendor's public host: it exists
  for a self-hoster behind an egress proxy, and so the integration can be
  exercised end to end against a stub without stubbing anything in product code.

- a9ea2ca: Growth attribution, an explicit parameter allowlist, and the contact sync outbox

  `@slate/shared` gains `parseAttribution`, the one definition of which inbound
  campaign parameters may ever be recorded: exactly seven keys, normalized, with
  the referrer read from the request header and only when cross-origin. Organic
  traffic yields nothing rather than a synthetic `direct`. `ATTRIBUTION_COOKIE`
  and `ATTRIBUTION_WINDOW_MS` ship alongside it, so the parking cookie's lifetime
  and the account-age window the claim enforces are the same constant.

  `@slate/db` gains `claimAttribution`, which stamps that blob onto an account
  **write-once** and only inside the ten-minute window, reporting the true winner
  from an affected-row count on both dialects. It carries no policy of its own —
  the caller passes an absolute cutoff — so the package needs no dependency on
  `@slate/shared`. Two nullable columns on `account`, with a numbered additive
  migration in both dialects and deliberately **no backfill**: `NULL` is the
  truthful state for every account that predates it. `OutboxKind` gains
  `dapta_sync` and `iam_onboarding`, which is a type-level change only.

  `@slate/types` gains the `entry_type` vocabulary and a closed schema for the
  attribution claim body, so an unknown key is rejected at the boundary rather
  than stored permanently.

  `@slate/config` gains the optional `DAPTA_SYNC_*` destination. Unset — the
  default, and the only sensible value for a fork — nothing is ever sent: the rows
  are enqueued and the worker records them as skipped with a reason.

- 826dd17: Add a per-event-type duplicate-booking guard, off by default. When a host
  switches it on, one normalized email address may hold at most one upcoming
  booking on that event; both public write paths honour it, and host-initiated and
  API-key writes are exempt. A blocked booker gets `409 DUPLICATE_BOOKING` with no
  slot detail.
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

- 72f921c: Move reminders and the follow-up from the account to the event type.

  Each event type carries a list of `{ id, kind, enabled, leadMinutes, subject, body }`
  rows on the new additive `event_type.reminders` column: every reminder has its own
  switch, its own lead time and its own copy, capped at 10 plus one follow-up. A new
  event type is born with 24h + 1h enabled and the follow-up off.

  Reminder copy can quote the event's own intake answers through a new
  `{{form.<field name>}}` namespace. The prefix is what keeps a question named
  `location` from shadowing the built-in `{{location}}`, so no new names are reserved
  and existing saved forms keep working. An unanswered or deleted question renders
  empty and its line is dropped, exactly as an absent built-in already does.

  Existing event types are given a copy of their account's current lead times and copy
  by an idempotent migration fixup, so no host loses configuration and no invitee's
  mail moves. `attendee_reminder`, `host_reminder` and `follow_up` are no longer
  listed or editable in Settings → Notifications; the 9 transactional keys are
  unchanged. The host side of a reminder keeps its shipped template — the row's
  subject and body are the invitee copy.

  Two consequences worth stating. Host-side reminder _copy_ stops being editable
  (its lead time and its on/off become per-event, which is the upgrade). And a
  stored `host_reminder: disabled` survives as a legacy **mute** on the host side —
  it can silence, never enable — so a host who had turned their own copies off does
  not start receiving them again; an account that never touched it is unaffected.

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

- fe5b2a1: Bound the public team availability window, and give a soft hold back.

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

  One behaviour change an API consumer can see: `GET /v2/slots` resolves a TEAM
  event through `teamAvailability`, so a query wider than 60 days is now clamped
  there rather than answered in full. The personal branch has always clamped, so
  this makes the two agree.

- be1348d: Make a reschedule answer to the host set the booking was created with.

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
  pending booking holds its slot. The insert guard and the move guard are now
  one function, so they cannot drift apart again.

  Adds `getBookingRescheduleAvailability`, the availability read behind the
  manage page's reschedule picker for a team booking. The public team route
  answers what an event offers a NEW invitee, and for round-robin that is the
  union across hosts; a reschedule keeps the host it was assigned, so the picker
  was offering times the write refused with `INVALID_SLOT`. The new read is
  scoped to the booking's own assigned hosts and intersected, so the picker and
  the write cannot disagree. It drops the booking being moved from its own
  hosts' busy sets, exactly as the write does, so buffers around a booking no
  longer stop it moving to the slot next door.

  `isSlotBookable` now reads its busy set through `loadBusyForHost`, which is
  the definition of busy the availability projections use — a member is busy for
  a booking whether they hold it as its organizer or as an assigned co-host. Its
  own query matched `host_member_id` only. It also takes an optional
  `hostScheduleId`, so a team host's own `event_type_host.schedule_id` resolves
  the way the team availability projection resolves it; omitted, it behaves
  exactly as before. The v2 reschedule surface passes it too, so both reschedule
  paths resolve a team host's hours the same way.

  `@slate/types` gains `rescheduleAvailabilityQuerySchema` for the new read's
  window, so an unparseable instant is a 400 rather than a `RangeError` out of
  the slot engine.

  No schema change and no migration.

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

- 35ea4ff: Webhook signing secrets are encrypted at rest

  `webhook.secret` was plain `text` in both dialects, readable by anyone with
  database access. Unlike `api_key` it cannot be hashed — the signer has to read
  it back to build the `X-Slate-Signature` HMAC — so it now rides the same
  AES-256-GCM envelope the CRM credentials use (`v1.<iv>.<tag>.<ciphertext>`,
  keyed by `INTEGRATION_ENCRYPTION_KEY`), in a new nullable `secret_cipher`
  column.

  The binding is its own AAD, `webhookSecretAad(accountId, webhookId)` —
  `${accountId}:webhook:${webhookId}` — never the CRM's `secretAad`. A ciphertext
  lifted into another webhook's row, another account, or the integration table
  fails to decrypt rather than quietly signing deliveries with a secret it was
  never sealed for.

  A separate column rather than an in-place envelope on `secret`, because
  `POST /v1/webhooks` accepts a caller-supplied secret: an in-place envelope would
  have to infer "envelope or literal secret?" from the string's shape, and a
  caller may legitimately supply one starting with `v1.`. A column makes "is this
  encrypted" a schema fact. It also keeps every old row valid with no rewrite —
  the migration adds a column and touches no data.

  Decryption happens only at signing time, in the three places that build the
  signature: `pingWebhook`, `dispatchWebhooks` and `deliverWebhookEvent`. No read
  endpoint returns a secret, and `MatchingWebhook` no longer carries one.
  `createWebhook` takes a required `key: Buffer`, so the compiler rather than a
  runtime branch is what guarantees no call site writes plaintext.

  Secret generation and the signature itself are unchanged: `whsec_` plus 24
  random bytes, `sha256=<hex>` HMAC-SHA256 over the raw body.

  When `INTEGRATION_ENCRYPTION_KEY` is absent, an existing plaintext secret keeps
  working and signs exactly as it does today; a stored envelope refuses loudly
  rather than falling through to an unsigned delivery; and creating a webhook
  refuses with a coded `INTEGRATION_KEY_MISSING`, the same shape
  `connectIntegration` already returns. Once a key is present, a legacy plaintext
  row is re-sealed in place the first time it signs, with a byte-identical
  signature. A deployment can never newly write a plaintext secret.

  Additive migration in both dialects, order-independent.

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
- 6048203: Index `slot_reservation.uid`.

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

- Updated dependencies [a0f172d]
- Updated dependencies [22252c0]
- Updated dependencies [7c23eba]
- Updated dependencies [95b8e5f]
- Updated dependencies [327819e]
- Updated dependencies [7c38767]
- Updated dependencies [7581691]
- Updated dependencies [a9ea2ca]
- Updated dependencies [c8ce5e0]
- Updated dependencies [07e6932]
- Updated dependencies [826dd17]
- Updated dependencies [03fd0e0]
- Updated dependencies [ff2e458]
- Updated dependencies [fcece25]
- Updated dependencies [72f921c]
- Updated dependencies [6016620]
- Updated dependencies [fe5b2a1]
- Updated dependencies [5a7df37]
- Updated dependencies [29e39cc]
- Updated dependencies [be1348d]
- Updated dependencies [0915e8f]
  - @slate/types@0.1.0
  - @slate/calendar@0.1.0
  - @slate/engine@0.1.0
