---
"@slate/db": minor
"@slate/config": minor
"@slate/shared": minor
---

OAuth for the MCP endpoint, off by default (`OAUTH_ENABLED`). The API becomes
its own OAuth 2.1 authorization server (oidc-provider) so Claude, ChatGPT,
Cursor and VS Code connect to `/mcp` with a sign-in and a consent screen instead
of a pasted key. PKCE S256 required, exact redirect matching (any port on
loopback), RFC 8707 resource indicators with the MCP URL as the token audience,
RFC 9207 `iss`, RFC 8414 and RFC 9728 metadata, Client ID Metadata Documents
(SSRF-guarded) and Dynamic Client Registration restricted to a redirect
allowlist, ES256 JWT access tokens verified without a database read, rotating
refresh tokens with reuse detection, RFC 7009 revocation. The person signs in
through the existing `AUTH_PROVIDER` on a new web page, `/auth/consent`; only
owners and admins can approve. The MCP door answers a protected tool with no
token with HTTP 401 and `WWW-Authenticate: Bearer resource_metadata=...`, and a
token lacking a scope with 403 `insufficient_scope`; `dcl_` keys are unchanged.
Settings, MCP and API gains Connected apps with Disconnect, and the chat-app tab
shows the real add-connector steps when OAuth is on. One additive table,
`oauth_record`. New env: `OAUTH_ENABLED`, `OAUTH_ISSUER`, `OAUTH_SIGNING_JWK`,
`OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `OAUTH_GRANT_TTL_DAYS`,
`OAUTH_REFRESH_REUSE_GRACE_SECONDS`, `OAUTH_CIMD_ENABLED`, `OAUTH_DCR_ENABLED`,
`OAUTH_DCR_EXTRA_REDIRECT_URIS`. See `docs/MCP.md` and `SELF-HOSTING.md`.
