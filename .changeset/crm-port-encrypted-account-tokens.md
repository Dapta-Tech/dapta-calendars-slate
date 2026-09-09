---
'@slate/crm': minor
'@slate/db': minor
'@slate/types': minor
'@slate/shared': minor
'@slate/config': minor
---

A `CrmProvider` port, encrypted per-account credentials, and the CRM write-out

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
