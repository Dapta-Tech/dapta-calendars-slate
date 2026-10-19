---
"@slate/api": minor
"@slate/web": minor
"@slate/db": minor
"@slate/config": minor
"@slate/shared": minor
---

OAuth for the MCP endpoint through an external authorization server. With
`OAUTH_ENABLED=true` and the new `OAUTH_AUTHORIZATION_SERVER` (the server's
issuer, an origin), the API is an OAuth resource server only: the built-in
authorization server is not mounted (its routes, the consent page and Connected
apps answer 404) and `OAUTH_ISSUER` / `OAUTH_SIGNING_JWK` are not needed.
Protected-resource metadata names the external server, its own metadata is
served from this origin for older clients (fetched server-side, cached, size
and time bounded), and the MCP door verifies its access tokens against its JWKS
(RS256 or ES256, exact `iss`, `aud` containing `MCP_PUBLIC_URL`, `sub` and `exp`
required). Any failure is the 401 challenge, never a 500. Optional
`OAUTH_JWKS_URL` overrides the metadata's `jwks_uri`. Unset, the built-in server
runs exactly as before.

A token's `sub` maps to the members whose new `member.idp_subject` carries it
and who are active owners or admins, checked on every request; none is a 403.
The `workos` login provider records `workos_user_id` there at web login (the
latest login within an account wins). A sign-in acts with the member's admin
rights; one reaching several accounts names one with the new optional
`account_id` argument, and the new `list_my_accounts` tool lists them (an API
key returns its own account). `account_id` appears on every tool that acts on
the caller's account, in every mode; a key or a single-account connection may
name only its own account, anything else is `NOT_FOUND`.

One additive migration in both dialects: the nullable `member.idp_subject`
column and a unique index on (`idp_subject`, `account_id`).
