---
"@slate/api": patch
"@slate/web": patch
---

With sign-in through an external authorization server, MCP, Connect and keys
leads with signing in: step 1 is "Sign in from your app", with Claude, Claude
Desktop and ChatGPT first, then Cursor (a one-click link and an `mcp.json` with
the address only), Claude Code (`claude mcp add` with no header, then `/mcp`)
and any other app that signs in. Step 2 is an API key, for headless agents and
scripts or narrower access. Built-in OAuth and keys-only installations keep
today's order. That server's sign-ins leave nothing the page can read, so the
sign-in step is never marked done, and a done step only says a key was used
unless an app really signed in through this API's own server.

The MCP server's no-key hint names every tool that works without a key
(`find_available_slots`, `find_team_slots`, `hold_slot`, `book_meeting`,
`book_team_meeting`), read from the tool catalog so it cannot drift, and
`whoami` says it takes an API key or a sign-in. On API docs, `whoami` and
`list_my_accounts` say "Works with any key or a sign-in" where the
installation signs agents in. In Spanish, the mobile menu button, the nav's
name, the operator account picker and the webhook event names are translated
(the wire names stay as they are).
