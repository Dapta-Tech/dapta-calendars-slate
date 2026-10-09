# @slate/crm

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

- c8ce5e0: Add the host-facing half of the HubSpot integration: an Integrations tab under
  Settings, admin-only, where an account connects one private-app token, sees the
  connection's health, and disconnects.

  `@slate/crm` gains `requiredScopes` on the `CrmProvider` port — the scope names
  a credential must carry, spelled as the provider spells them. The connect
  dialog's checklist renders this list, so the setup instructions a host follows
  and the permissions the adapter actually needs are ONE list that cannot drift.
  HubSpot returns `HUBSPOT_REQUIRED_SCOPES`, which already existed for exactly
  this; `DisabledCrmProvider` returns none.

  `@slate/types` gains `IntegrationCapabilities`, the response of a new additive
  `GET /v1/integrations/capabilities`. The two states in which connecting cannot
  succeed — no CRM adapter selected, and no `INTEGRATION_ENCRYPTION_KEY` — are
  deployment configuration a browser could otherwise only discover by pasting a
  credential and being refused, after being sent off to create a private app. It
  also carries the adapter's `requiredScopes`. The three routes shipped in H1a are
  unchanged, and nothing here returns a token.

  `@slate/shared` gains the `admin.integrations` message block in `en` and `es`,
  plus the `admin.settings.integrations` tab label. Note what is absent from it:
  the scope names, which come from the adapter rather than from copy so no
  translator can edit a provider identifier.

### Patch Changes

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
- Updated dependencies [fcece25]
- Updated dependencies [72f921c]
- Updated dependencies [6016620]
- Updated dependencies [fe5b2a1]
- Updated dependencies [29e39cc]
- Updated dependencies [be1348d]
- Updated dependencies [0915e8f]
  - @slate/types@0.1.0
