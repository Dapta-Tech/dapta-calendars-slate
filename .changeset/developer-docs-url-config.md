---
"@slate/config": minor
---

New optional `DEVELOPER_DOCS_URL` in the server env schema: where a
deployment's developer guides live. Normalized by `cleanPublicUrl` like
`API_PUBLIC_URL` (http or https, no credentials, query or fragment; anything
else reads as unset). The API reference's introduction links it; unset, there
is no guides link.
