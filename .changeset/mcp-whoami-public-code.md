---
"@slate/api": patch
---

MCP `whoami` names the workspace the way its links and the dashboard do:
`account.code` is the claimed public name (the vanity slug) when the workspace
has one, else the short code, the same `canonicalPublicCode` the booking links
already use. Before, a workspace that claimed `dapta-fgo` showed its short code
(`uc8ict`), which the web layer only redirects from. The summary line follows.
Both codes keep working wherever a code is taken.
