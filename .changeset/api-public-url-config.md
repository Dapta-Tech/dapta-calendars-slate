---
"@slate/config": minor
---

New optional `API_PUBLIC_URL` in the server env schema: the API's own public
base URL, normalized by the new exported `cleanPublicUrl` (trimmed, http or
https only, origin plus path, no trailing slash). Unset, empty, not an http(s)
URL, or carrying credentials, a query or a fragment reads as unset, so nothing changes for a deployment that does not set it and a malformed
value never stops the API booting.
