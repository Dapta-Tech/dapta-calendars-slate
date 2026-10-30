---
"@slate/api": patch
"@slate/web": patch
---

"API docs" in the dashboard rail opens the API's own reference
(`<API_PUBLIC_URL>/docs`, the interactive console) directly, in a new tab with
the external-link arrow, like "Docs" and "Dapta Agents". The in-app page with
its two buttons is gone: `/admin/developers/docs` now redirects an owner or
admin to the reference (a member still gets the no-access panel; a deployment
with no public API address says so). The reference is never drawn inside the
dashboard. Its introduction gains a line with a visible link to the raw
`/openapi.json`, so the document is one click away from where people land.
