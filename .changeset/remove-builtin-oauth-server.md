---
"@slate/db": minor
"@slate/config": minor
"@slate/shared": minor
---

The built-in OAuth authorization server for the MCP endpoint is removed; OAuth
now always means an external authorization server (`OAUTH_AUTHORIZATION_SERVER`),
with the API as a resource server only. `@slate/config`: `OAUTH_ISSUER`,
`OAUTH_SIGNING_JWK`, `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, `OAUTH_GRANT_TTL_DAYS`,
`OAUTH_REFRESH_REUSE_GRACE_SECONDS`, `OAUTH_CIMD_ENABLED`, `OAUTH_DCR_ENABLED`
and `OAUTH_DCR_EXTRA_REDIRECT_URIS` leave the schema (a deployment that still
sets them boots, they are ignored); `OAuthMode` is `'off' | 'external'`; and
`OAUTH_ENABLED=true` without `OAUTH_AUTHORIZATION_SERVER` refuses to boot,
saying so. `@slate/db`: the `oauth-store` helpers are gone; the `oauth_record`
table stays, unused, until a later migration drops it. `@slate/shared`: the
consent page and Connected apps messages are gone.
