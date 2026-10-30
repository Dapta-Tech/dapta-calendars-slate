---
'@slate/types': minor
'@slate/crm': minor
'@slate/db': minor
'@slate/shared': major
---

The booking's campaign (its `utm_*`) reaches the CRM.

- `@slate/types`: `crmMappingSourceSchema` takes `{ kind: 'utm', field }`, `field` one of `BOOKING_UTM_KEYS`, under the same contract rules as every source (once per event, never onto identity, one source per property). Stored in the existing `event_type.crm_property_mappings` JSON column: no schema change.
- `@slate/crm`: a `utm` source targets a text property or a single-choice enumeration (matched to an option like any answer, omitted when none fits); `MappingValueContext` takes an optional `utm`. A campaign is one set: when the booking has any `utm_*`, a mapped key it lacks clears its property (an empty value), so two campaigns never mix on one contact; a booking without a campaign sends nothing. The HubSpot adapter passes that empty value on an update and drops it on a create. `renderMeetingBody` takes an optional `utm`, lists each key the booking kept, and turns `<` and `>` in the body into entities, so markup typed into a link or an answer reaches the CRM as text.
- `@slate/db`: `CrmWriteContext` carries `utm`, the booking's stored campaign or null.
- `@slate/shared`: EN and ES copy for the Campaign (UTM) group in the CRM mapping editor (`groupCampaign`, `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`, required members, hence major).
