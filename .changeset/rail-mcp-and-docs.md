---
"@slate/shared": minor
---

MCP and Docs in the admin sidebar, at the level of the dForms rail. "MCP & API"
leaves Settings and becomes an "MCP" item whose icon is the rotating Claude,
ChatGPT and Cursor logos, with three pages under it: Connect and keys
(`/admin/developers/keys`: a three-step guide to connect an agent, then the API
keys and the connected apps), Webhooks (`/admin/developers/webhooks`) and API
docs (`/admin/developers/docs`: the MCP tools and the API reference). An
accordion in the wide sidebar and the mobile drawer, a menu on the collapsed
sidebar. Owners and admins only, like the pages; a member is not shown it, nor
the Home shortcut to the keys. `/admin/settings/developer` and
`/admin/developers` redirect to the keys page. A "Docs" item, last, opens the
deployment's documentation in a new tab in the reader's language: new runtime
env `DOCS_URL` and `DOCS_URL_ES` on the web; unset, there is no Docs item. The
MCP server's "create a key" hints name the new place.
