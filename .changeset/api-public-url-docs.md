---
"@slate/api": patch
---

`/openapi.json` and `/docs` no longer name a hardcoded production host. With
`API_PUBLIC_URL` set, `servers` and the copy-paste examples use it; unset,
`servers` is relative (`/`) and the examples take the address the page was
opened at, so a fork's docs never point at someone else's API. The Flow Studio
quickstart uses `https://api.dcal.ai`.
