---
'@slate/shared': minor
---

Copy for "Connect your agent", the Tools page and the home promo, in both
locales: `admin.connect` (the connect guide: the recommended sign-in card, the
steps for Claude, the Claude directory, ChatGPT, Claude Code, Codex, Cursor,
OpenClaw and Hermes, the drawn walkthroughs, the "not available" note),
`admin.tools` (the tool groups and a plain-language line and example request
for each of the 17 MCP tools), `admin.home.agentBanner` and
`admin.home.agentCard`, and the rail's `admin.nav.connect`, `admin.nav.tools`
and `admin.nav.api` ("API and webhooks"). `{product}`, `{server}` and `{count}`
are filled in by the web app. `admin.oauthConsent.staysConnected` and
`admin.developer.pageLead` now point at the new places.

**Minor, not patch:** members are REMOVED from the exported `BookingMessages`
interface: `admin.nav.developers`, `admin.home.apiKeys` and `apiKeysDesc`, and
the old key-first setup guide's keys under `admin.developer` (`connectTitle`,
the `tab*`, `chat*`, `signIn*` and `guide*` keys other than `guideSkill*`,
`cursor*`, `claudeCodeLead`, `codexLead`, `other*`, `stepKeyEnv`,
`mcpUrlLabel`, `mcpUrlMissing`, `mcpUnavailable`, `addToCursor`, `addToClaude`,
`toolsTitle`, `toolsLead`, `toolNeeds`, `toolNeedsAnyKeyOrSignIn` and
`copyPrompt`). A fork that maintains its own locale object literal against
that interface has to drop those keys and add the new ones to keep compiling.
