# @slate/config

## 0.1.0

### Minor Changes

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
