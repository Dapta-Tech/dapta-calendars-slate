---
"@slate/types": minor
"@slate/shared": minor
"@slate/crm": minor
---

Add the host-facing half of the HubSpot integration: an Integrations tab under
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
