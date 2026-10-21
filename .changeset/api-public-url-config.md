---
"@slate/config": minor
---

New optional `API_PUBLIC_URL` in the server env schema: the API's own public
base URL, normalized by the new exported `cleanPublicUrl` (trimmed, http or
https only, no trailing slash). Unset, empty or not an http(s) URL reads as
unset, so nothing changes for a deployment that does not set it and a malformed
value never stops the API booting.
