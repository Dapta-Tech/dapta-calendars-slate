---
"@slate/api": patch
"@slate/web": patch
---

`/openapi.json` and `/docs` no longer name a hardcoded production host. With
`API_PUBLIC_URL` set, `servers`, the copy-paste examples and the document
links use it, and the explorer loads the document from the page's own origin
with the path prefix kept, so a path prefix works; unset, `servers` is relative
(`/`), the examples take the address the page was opened at, and a no-script
reader is told to use the page's address minus `/docs`. A fork's docs never
point at someone else's API. The calendar backend's User-Agent drops its
hardcoded contact URL. The web reads `API_PUBLIC_URL` through the same
`cleanPublicUrl` as the API. The Flow Studio quickstart uses
`https://api.dcal.ai`.
