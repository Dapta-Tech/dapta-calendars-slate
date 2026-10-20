---
"@slate/api": minor
"@slate/web": minor
---

The built-in OAuth authorization server for the MCP endpoint is removed; OAuth
now always means an external authorization server (`OAUTH_AUTHORIZATION_SERVER`),
with the API as a resource server only. Gone: `oidc-provider`, every `/oauth/*`
route, the consent API (`/v1/oauth/consent`), Disconnect
(`DELETE /v1/oauth/grants/:id`), the web's `/auth/consent` page, Connected apps
on MCP, Connect and keys, the built-in token check and its 403 step-up on the
MCP door, and `pnpm e2e:oauth`. `GET /v1/oauth/grants` stays as the switches
the MCP pages read (`external`, `mcpEnabled`), always with no grants. The
settings of the removed server are ignored if still set; `OAUTH_ENABLED=true`
without `OAUTH_AUTHORIZATION_SERVER` refuses to boot.
