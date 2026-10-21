---
"@slate/config": minor
---

New optional `API_PUBLIC_URL` in the server env schema: the API's own public
base URL. Unset or empty means unset, so nothing changes for a deployment that
does not set it.
