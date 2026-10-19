---
"@slate/api": patch
"@slate/web": patch
---

The MCP & API page shows how to connect an agent only when the API serves MCP.

- `GET /v1/oauth/grants` (the Connected apps read the page already makes) also
  answers `mcpEnabled`: the API's own `MCP_ENABLED`. One source of truth; the web
  gets no second flag.
- The page builds the Cursor, Claude Code, Codex, Claude connector and generic
  snippets only on `mcpEnabled: true`. Before, it built them from the web's
  `MCP_PUBLIC_URL` / `API_PUBLIC_URL` alone, so a deployment with those set and
  `MCP_ENABLED=false` told hosts to connect to an address that answers 404.
- MCP off, an older API without the field, or a failed read all show one plain
  sentence instead of the steps, with no address. Fail closed. API keys, webhooks,
  connected apps and the API reference are unchanged.
