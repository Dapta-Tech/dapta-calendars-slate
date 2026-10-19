---
"@slate/types": minor
"@slate/config": minor
"@slate/db": minor
---

Add the `bookings:cancel` API-key scope (destructive, separate from
`bookings:write`; no migration, scopes are stored as JSON). `GET /v1/api-keys`
now also returns each key's `scopes`, `eventTypeIds`, `expiresAt` and
`lastUsedAt`. The server env schema gains the optional `MCP_*` settings, all
safe when unset or blank.
