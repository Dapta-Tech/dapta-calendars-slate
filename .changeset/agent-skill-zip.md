---
"@slate/shared": minor
---

MCP, Connect and keys ends its setup guide with "No MCP in your agent?": a
download of the API skill, a zip that teaches any agent with a terminal to use
the API with the same key. Owners and admins only (`GET /api/developers/skill`).
The zip is built per request for the installation it comes from: `SKILL.md`
(authentication, MCP or REST, the scopes, the rules the API enforces, booking a
meeting step by step), `INSTALL.md` for Claude Code, Codex and Cursor, the MCP
tools, and an endpoint reference generated from the API's own `/openapi.json`
(the routes it documents for integrations), which ships in the zip too. Every
route the skill names, and every error code or header a rule quotes, is checked
against that document first. Addresses come from runtime env (`API_PUBLIC_URL`
or `MCP_PUBLIC_URL`, and `PUBLIC_APP_URL`); with no public API address the guide
says the skill is not available instead of offering it, and a download refused
later (the session ended, a member) says why under the button. The zip never
holds a key: every snippet reads `DAPTA_CALENDARS_API_KEY`. New copy in EN and
ES.
