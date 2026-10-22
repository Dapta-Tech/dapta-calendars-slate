---
"@slate/api": patch
"@slate/web": patch
---

The web image runs on Node 22 LTS, the same digest-pinned `node:22-trixie-slim`
base the API image builds on, instead of an unpinned `node:20-slim`. Node 20 left
support on 2026-04-30, so the internet-facing web was getting no security fixes.
The shared base moves to Node 22.23.4 (the 2026-10-20 security release; the API
build stage was on 22.23.1), and CI and `.nvmrc` move to the same Node. Building
either app from source now needs Node 22.13 or later: the root `engines` floor
moves up from 20.9.0, and `pnpm install` warns on an older Node. Nothing else
changes: the web's standalone server still reads `KEEP_ALIVE_TIMEOUT`, the web
image still runs as the `node` user on port 3000, and the API's distroless
runtime is unchanged.
