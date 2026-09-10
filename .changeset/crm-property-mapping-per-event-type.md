---
"@slate/crm": minor
"@slate/db": minor
"@slate/types": minor
"@slate/shared": minor
"@slate/config": minor
---

Map intake questions onto CRM contact properties, per event type.

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
