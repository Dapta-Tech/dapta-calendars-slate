---
"@slate/api": patch
---

`/docs` is one page: the Scalar reference alone, full page, themed with the web
app's palette and face in light and dark, with the static block that sat above
it removed. Its introduction now lives in the OpenAPI document
(`info.description`), written for the people who call the API: the base URL,
`dcl_` key authentication and the API keys page on `PUBLIC_APP_URL`, the two
APIs, the `cal-api-version` each `/v2` operation needs (asserted equal to the
paths), safe retries with `Idempotency-Key`, the MCP server when
`MCP_PUBLIC_URL` is set, and the guides when the new optional
`DEVELOPER_DOCS_URL` is set. `info.version` is `2.0.0`. Scalar and the font load
from a CDN pinned to an exact version with Subresource Integrity, and the
explorer runs with Scalar's telemetry, agent chat and MCP integration off.
Paths, schemas and operation ids are unchanged.
