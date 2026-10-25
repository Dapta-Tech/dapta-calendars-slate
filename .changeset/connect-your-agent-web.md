---
'@slate/web': minor
---

"Connect your agent", the same page as dForms': `/admin/developers/connect`
connects Claude, ChatGPT, Claude Code, Codex, Cursor, OpenClaw or Hermes to the
MCP by signing in with the person's account, with no API key. A tab per app
(arrow keys, the pick remembered in the browser) with a drawn, looping
walkthrough of that app (CSS keyframes; reduced motion shows the last frame; a
click pauses; a step's number jumps to it) over numbered steps with copy blocks.
Every snippet is built on the server for the runtime MCP address, under the
server name `dcal` (existing installs under `dapta-calendars` keep working). On
a phone, what needs a computer becomes "Open this page on your computer to
connect {app}". Shown only when the API serves MCP and takes a sign-in;
otherwise a note says the connector is not available here.

New runtime variable `MCP_CLAUDE_DIRECTORY_URL` (https only): set, Claude's tab
starts at the connector's page in Claude's directory, with the custom-connector
steps folded under it. A map by MCP address can name a listing with no setting;
it is empty until the hosted MCP is listed.

New Tools page (`/admin/developers/tools`): the 17 MCP tools in six groups, in
plain words with an example request each, held by a spec to the API's catalog.

The rail follows the product pages with "Connect your agent" (prominent, the
rotating AI app logos, a soft glow) and "Tools", then a quiet "API and webhooks"
group with API keys, webhooks and the API docs; owners and admins only, as
before. `/admin/developers` and `/admin/settings/developer` now redirect to the
connect page. The API keys page loses its setup guide (keys, the skill download
and Connected apps stay); the API docs page keeps the API reference, and the
tool list moved to Tools. The home shows owners and admins an agent banner and
a "Connect your agent" card with a typed demo, in place of the old shortcut.
