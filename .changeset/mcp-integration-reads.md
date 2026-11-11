---
"@slate/shared": patch
---

The last dashboard reads on the MCP: `list_event_types` takes an optional
`team_id`, and three new tools read the calendars inside a connected account
(`list_connection_calendars`, `availability:read`), the CRM integration's status
and what the deployment supports (`list_integrations`), and the CRM's contact
properties (`list_crm_contact_properties`, both `event-types:read`). They close
five more `not-yet` routes in `parity.ts`.
