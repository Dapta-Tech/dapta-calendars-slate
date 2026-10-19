# MCP endpoint

Calendars serves a remote [Model Context Protocol](https://modelcontextprotocol.io)
endpoint, so an agent can find a free slot, book, reschedule and cancel meetings
without a custom integration.

- **URL:** `POST <your-api-origin>/mcp` (set `MCP_PUBLIC_URL` to the address you
  want shown to your users).
- **Transport:** Streamable HTTP, stateless. No session id, no sticky sessions:
  any replica can answer any call.
- **Protocol:** one handler serves 2026-07-28 clients and legacy `initialize`
  clients (2025-06-18, 2025-11-25).
- **On by default.** Set `MCP_ENABLED=false` and the endpoint answers 404.

## Three ways in

| Door | How | What it can do |
|---|---|---|
| No credential | Just call it | `find_available_slots` and `book_meeting` on a **public** booking page |
| API key | `Authorization: Bearer dcl_...` | Everything below, limited by the key's scopes and event-type allowlist |
| OAuth (opt-in, `OAUTH_ENABLED`) | Sign in and approve; the app sends `Authorization: Bearer <access token>` | Everything below, limited by the scopes the person approved (this API's own server), or by the person's owner or admin role (an external authorization server) |

A key is created by a workspace admin (Settings, then API keys). Send it only in
the `Authorization` header. A key in the URL (`?api_key=`, `?access_token=`) is
refused with 400 so it never lands in an access log. A wrong, expired or revoked
key answers 401; it is never quietly treated as anonymous. The account always
comes from the credential: a key acts on its own account, and a sign-in that
reaches several accounts names one per call with `account_id` (one of the
accounts the credential reaches, never another). Anything outside it (another
workspace, a booking outside the key's allowlist) is reported as `NOT_FOUND`.

## Tools

| Tool | Needs | Kind | What it does |
|---|---|---|---|
| `find_available_slots` | public page link, or `availability:read` (by `event_type_id`) | read | Open times for one event, grouped by local date, each with its offset in the `time_zone` you ask for plus UTC. Range capped at 31 days. |
| `book_meeting` | nothing (public page) | write, emails the invitee | Books one offered slot. Same validation as the public booking page. |
| `whoami` | any key or connection | read | Workspace, owner time zone, the key's (or connection's) scopes and allowlist. |
| `list_my_accounts` | any key or connection | read | The accounts this connection can act in, by name and id. A key reaches only its own. |
| `list_event_types` | `event-types:read` | read | Bookable event types (personal and team), respecting the allowlist. |
| `get_booking_page_link` | `event-types:read` | read | Public URL of one event type. |
| `list_bookings` | `bookings:read` | read | Minimal fields only: uid, status, times, event type, invitee email domain. Cursor pagination. |
| `get_booking` | `bookings:read` | read | One booking. Invitee name, email, notes and intake answers sit inside `invitee_supplied`. |
| `create_booking` | `bookings:write` | write, emails the invitee | Books an offered slot on any event type of the workspace. |
| `reschedule_booking` | `bookings:write` | write, emails the invitee | Moves a booking to a new offered slot. The booking gets a **new uid**. |
| `cancel_booking` | `bookings:cancel` | **destructive**, emails the invitee | Cancels. The scope is separate from `bookings:write` on purpose. |

Every tool carries a title, `readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`, an input schema, and an output schema with `structuredContent`
(plus a short text summary). Not exposed over MCP: webhooks, API keys, team
administration, event-type edits, confirm or decline.

Every tool that acts on the caller's account (all but `book_meeting` and
`list_my_accounts`) takes an optional `account_id`. A key or a sign-in that
reaches one account never needs it, and may name only that account. A sign-in
that reaches several accounts must name one on each call; without it the call
fails with `ACCOUNT_REQUIRED` listing the accounts; `list_my_accounts` returns the same list.
A public booking page needs no account: `find_available_slots` and `book_meeting`
on a page link take theirs from the link.

`bookings:cancel` is a new scope. The REST cancel routes (`/v2/bookings/:uid/cancel`
and `/v1/machine/bookings/:uid/cancel`) accept `bookings:cancel` **or**
`bookings:write`, so existing keys keep working there; the MCP tool requires
`bookings:cancel`.

### Booking safely

- Only start times returned by `find_available_slots` can be booked. A taken time
  is `SLOT_TAKEN`, a time that was never offered is `INVALID_SLOT`; both tell the
  agent to fetch slots again.
- `create_booking`, `book_meeting` and `reschedule_booking` take a required
  `idempotency_key`. Retrying the same action with the same key returns the same
  booking; reusing a key for a different action is `IDEMPOTENCY_KEY_REUSED`.
  `book_meeting` scopes the key to the caller, so anonymous callers cannot replay
  each other's bookings.
- Intake questions are listed by `find_available_slots` and `list_event_types`;
  answers go in `answers`.

### Untrusted text

Anything an invitee typed (names, notes, answers, reasons) is hostile input to a
model. It is returned only by `get_booking`, inside `invitee_supplied`, with
control and zero-width characters, HTML and markdown links and images removed and
every value length-capped. `list_bookings` returns no free text at all. Tell your
agent to treat `invitee_supplied` as data, never as instructions.

## Connect an agent

Replace `https://api.example.com/mcp` with your endpoint and `dcl_xxx` with a key.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "calendars": {
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:CALENDARS_API_KEY}" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add --transport http calendars https://api.example.com/mcp \
  --header "Authorization: Bearer $CALENDARS_API_KEY"
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.calendars]
url = "https://api.example.com/mcp"
bearer_token_env_var = "CALENDARS_API_KEY"
```

**Any agent SDK** (TypeScript, official client):

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://api.example.com/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.CALENDARS_API_KEY}` } },
  }),
);
const slots = await client.callTool({
  name: 'find_available_slots',
  arguments: { booking_page_url: 'https://app.example.com/acme/alex/intro-call', time_zone: 'America/Bogota' },
});
```

Leave the header out to use only the public tools.

## OAuth: connect Claude, ChatGPT, Cursor or VS Code with a sign-in

With `OAUTH_ENABLED=true` (and no `OAUTH_AUTHORIZATION_SERVER`, see the next
section) the API is also its own OAuth 2.1 authorization
server, so chat apps and IDEs connect with one click and a consent screen
instead of a pasted key. It is built on
[oidc-provider](https://github.com/panva/node-oidc-provider) (no hand-rolled
protocol code) and asks no identity vendor for anything: the person signs in
the way the dashboard already signs them in (the configured `AUTH_PROVIDER`).
Setup is in `SELF-HOSTING.md` ("OAuth for the MCP endpoint").

**What a client sees**

| Endpoint | Path |
|---|---|
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` |
| Authorize, token, register (DCR), revoke (RFC 7009), JWKS | `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/oauth/jwks` |

- **PKCE S256 is required** for every client; `plain` is refused.
- **Redirects match exactly.** A loopback redirect (`http://localhost`,
  `http://127.0.0.1`) may use any port, as RFC 8252 requires for native apps.
- **Resource indicators (RFC 8707).** The only resource is the MCP URL
  (`MCP_PUBLIC_URL`); access tokens carry it as their audience, and a request
  for any other resource is `invalid_target`.
- **`iss` in the authorization response (RFC 9207)**, advertised in the metadata.
- **Clients identify themselves two ways.** By a Client ID Metadata Document
  (CIMD: the `client_id` is an https URL this server fetches; what Claude and
  ChatGPT prefer), or by Dynamic Client Registration (what Cursor and VS Code
  use), which only accepts these redirect URIs: `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, `https://www.cursor.com/agents/mcp/oauth/callback`,
  `https://vscode.dev/redirect`, `https://chatgpt.com/connector_platform_oauth_redirect`,
  `http://localhost:<port>/callback`, `http://127.0.0.1:<port>/<path>`, plus any
  the operator adds (`OAUTH_DCR_EXTRA_REDIRECT_URIS`). A registration nobody
  connects with expires after a day.
- **Metadata documents are fetched carefully:** https on the default port only,
  every resolved address must be public (private, loopback, link-local and other
  special-use ranges are refused before connecting, and refused again on the
  connected socket against DNS rebinding), 5 KB and 2.5 s caps, a bounded cache,
  and rate limits per client address and overall.
- **Tokens.** Access tokens are ES256 JWTs (`typ: at+jwt`) signed with
  `OAUTH_SIGNING_JWK`, one hour by default, checked on every replica without a
  database read (signature, `iss`, `aud`, expiry). Refresh tokens rotate on every
  use; presenting a spent one revokes the whole connection (after a short retry
  grace, `OAUTH_REFRESH_REUSE_GRACE_SECONDS`, default 10 s). A connection lives
  at most `OAUTH_GRANT_TTL_DAYS` (90) however often it refreshes. Refresh tokens
  and codes are stored hashed.

**Signing in, step by step**

1. The app calls a protected tool with no token and gets **HTTP 401** with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="event-types:read availability:read bookings:read"`
   (plus the tool's own scope). Public tools, `initialize` and `tools/list`
   still work with no token.
2. The app sends the person to `/oauth/authorize`. The browser lands on the web
   app's consent page (`/auth/consent`), through the normal login if they are
   signed out.
3. The page shows the app's name **next to the host it is identified by** (the
   metadata document's host, or the redirect's for a registered client), where
   the answer goes, the workspace, and the access in plain words. Loopback
   redirects carry a warning. Only an **owner or admin** can allow, the same
   people who can create an API key, because a connection acts for the whole
   workspace. Anyone signed in can deny.
4. Allow or Deny goes back through this server, which checks that the same
   browser started the request; the app receives a code (or `access_denied`)
   with `iss`, and exchanges it with its PKCE verifier.

Every authorization shows the consent screen; nothing is remembered between
requests. A new connection gets the read scopes. When the app first calls a
write or cancel tool it gets **HTTP 403** `error="insufficient_scope"` listing
every scope it needs, and asks the person to approve again (step-up). API keys
keep their scope errors as tool results, because a key's scopes cannot be
stepped up.

**Connected apps.** Settings, MCP and API lists every connection of the
workspace (app, host, scopes, who approved it, when, last used) with
**Disconnect**. Disconnecting revokes the connection: its refresh token stops
working at once; an access token it already holds keeps working until it
expires (at most `OAUTH_ACCESS_TOKEN_TTL_SECONDS`). A member who is disabled,
removed or no longer an owner or admin can no longer refresh either.

**Add it in Claude** (claude.ai, Desktop, mobile): Settings, then Connectors,
then Add custom connector; paste the MCP URL; click Add, then Connect. The page
in Settings, MCP and API has an **Add to Claude** button that pre-fills the
dialog. In Claude Code:

```bash
claude mcp add --transport http calendars https://api.example.com/mcp
# then, inside Claude Code: /mcp, pick calendars, Authenticate
```

**Add it in Cursor** (`~/.cursor/mcp.json`): give only the URL, no headers.
Cursor registers itself (DCR), shows the server as needing sign-in, and opens
the consent page when you click it.

```json
{ "mcpServers": { "calendars": { "url": "https://api.example.com/mcp" } } }
```

**ChatGPT:** Plugins, then the plus button, then Add custom MCP server; paste the
MCP URL and choose OAuth.

## OAuth with an external authorization server

Set `OAUTH_AUTHORIZATION_SERVER` (with `OAUTH_ENABLED=true`) and the API is an
OAuth **resource server** only: sign-in, consent, client registration (CIMD,
DCR) and tokens all belong to that server. The built-in server above is not
mounted (`/oauth/*` and the consent page answer 404, Connected apps is hidden,
and `OAUTH_ISSUER` / `OAUTH_SIGNING_JWK` are not needed, nor read). Unset, the
built-in server runs exactly as described above.

Any OAuth 2.1 authorization server works if it supports **RFC 8707 resource
indicators** (its access tokens for `MCP_PUBLIC_URL` carry that URL as their
`aud`), signs them with **RS256 or ES256**, publishes a **JWKS**, and has an
issuer that is a bare origin (`https://auth.example.com`, no trailing slash):
for example WorkOS AuthKit. `OAUTH_AUTHORIZATION_SERVER` must be written exactly
as that origin; anything else is refused at boot, because it is compared with
every token's `iss`. Register `MCP_PUBLIC_URL` with the server as a resource (an
API, an audience). The login provider of this deployment (`AUTH_PROVIDER`) must
record that server's user id for the person, the `sub` of its tokens, on their
member (`member.idp_subject`) when they sign in to the web app; the bundled
`workos` provider does that with the `workos_user_id` claim of its platform
token.

| Endpoint | What it serves |
|---|---|
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | `{resource: MCP_PUBLIC_URL, authorization_servers: [OAUTH_AUTHORIZATION_SERVER], bearer_methods_supported: ["header"], scopes_supported: [], resource_name}` |
| `/.well-known/oauth-authorization-server` | The external server's own metadata, for clients that read it from the resource's origin: fetched server-side from the configured issuer (never with a header of the request), cached for an hour, 64 KB and 5 s caps, no redirects. 503 while it cannot be fetched. |

- **The challenge.** A protected tool with no token, or any call with a bad
  token, gets HTTP 401 and `WWW-Authenticate: Bearer resource_metadata="<MCP origin>/.well-known/oauth-protected-resource/mcp"`
  (`error="invalid_token"` for a bad one), never a `scope`. Every URL comes from
  configuration; the `Host` header changes none.
- **Token checks**, on every request: signature against the server's JWKS (its
  metadata's `jwks_uri`, whose `issuer` must equal `OAUTH_AUTHORIZATION_SERVER`
  exactly, or `OAUTH_JWKS_URL`), algorithm RS256 or ES256 only, `iss` exactly
  the configured issuer, `aud` containing `MCP_PUBLIC_URL`, `sub` and `exp`
  present, 30 s of clock tolerance. Nothing else in the token is trusted;
  `client_id`/`azp` and `sid` are only written to the audit line. Any failure,
  a key-fetch outage included, is the same 401, never a 500.
- **Who it acts as.** The token's `sub` finds the person: the members whose
  `idp_subject` is that `sub`. The link is per person, so it reaches the
  person's members in every account (the same upstream user, `external_id`),
  also where their login never carried the `sub` (an account they reach by
  switching). Of those, only members the identity service vouched for within
  `OAUTH_LINK_MAX_AGE_DAYS` (default 30: the issue time of the last token it
  minted for them, seen at a web login) count, the linking member included,
  and only active owners and admins (the same rule as the built-in server's
  consent). Checked on every request. None: **HTTP 403** with a plain message
  (open the web app once, then reconnect), never a 401, so the client does not
  loop back into its sign-in.
- **What it may do.** An external server has no scopes of ours, so a sign-in
  acts with the member's admin rights: every tool, no event-type allowlist, no
  step-up. For narrow access (read-only, one event type), use a scoped API key.
- **Several accounts.** One account is used automatically. With several, each
  call names one with `account_id`; `list_my_accounts` lists them.
- **The `resource` parameter.** A client that omits RFC 8707 `resource` when it
  asks for a token gets the authorization server's default audience, which is
  not `MCP_PUBLIC_URL`: every call is then a 401 and the client loops back into
  its sign-in. Register `MCP_PUBLIC_URL` with the server as an additional
  resource, not as its default (other resources may rely on the default), and
  use clients that send `resource`, as current Claude and Cursor do.
- **Disconnecting.** Remove the connector in the client. An owner can cut a
  person off by removing their admin role or the member.
- **Offboarding.** Removing the member here (or disabling them, or taking their
  admin role) cuts MCP access on the next request. Removing someone only in the
  upstream identity service, which this app is never told about, takes effect
  within `OAUTH_LINK_MAX_AGE_DAYS` of the last token it issued them for that
  account (its issue time, not when it was last used, so a token minted before
  the removal cannot keep the link alive): after that the link is stale and
  every call is the 403. Set it to the
  upstream session lifetime, so MCP access never outlives what the web allows;
  remove the member here too when it must end at once.

## Security

- **Transport.** The SDK handler checks nothing by itself, so the door does: a
  request carrying a browser `Origin` that is not in `MCP_ALLOWED_ORIGINS` is
  refused with 403 (clients without an `Origin`, which is every non-browser MCP
  client, are unaffected); `MCP_ALLOWED_HOSTS`, when set, restricts the `Host`
  header against DNS rebinding; only `POST` with `application/json` is accepted
  (405 / 415); bodies over 100 kB get 413; each tool call has a timeout
  (`MCP_TOOL_TIMEOUT_MS`), and a timed-out write tells the agent to retry with the
  same `idempotency_key` to find out safely.
- **Rate limits.** Per API key, or per client address for anonymous calls, with a
  tighter bucket for write tools (`MCP_RATE_LIMIT_*`, `MCP_WRITE_RATE_LIMIT_*`).
  Anonymous requests and failed key attempts also count against the address at the
  door (the existing `RATE_LIMIT_*` bucket). An exhausted bucket is a tool error
  `RATE_LIMITED` with a retry delay. **Buckets live in each process**: with N
  replicas the effective limit is up to N times higher. A shared limiter can be
  plugged in later behind the same `RateLimiter` interface.
- **Audit.** One JSON line on stdout per tool call: time, request id, protocol
  version, caller (key prefix such as `dcl_1a2b3c4d`, `oauth:<connection id>`
  plus the OAuth `client`, `login:<member id prefix>` plus the `client` and
  `sid` an external server's token carries, or `anonymous`), account id,
  tool, a hash of the redacted arguments, affected booking uids, result and
  latency. It never contains the key, names, emails, notes, answers or
  idempotency keys. Refused validation (a malformed call the SDK rejects before
  our code runs) is not audited.
- **Least privilege.** Separate read, write and cancel scopes, plus the optional
  event-type allowlist on the key. Create keys with only what the agent needs.

## Configuration

All optional; unset means the safe default. See `SELF-HOSTING.md` for the table.

| Var | Default |
|---|---|
| `MCP_ENABLED` | `true` |
| `MCP_PUBLIC_URL` | unset (display only; with OAuth on, required: it is the token audience) |
| `MCP_ALLOWED_ORIGINS` | unset (no browser origin allowed) |
| `MCP_ALLOWED_HOSTS` | unset (no Host check) |
| `MCP_RATE_LIMIT_CAPACITY` / `MCP_RATE_LIMIT_REFILL_PER_SEC` | `30` / `1` |
| `MCP_WRITE_RATE_LIMIT_CAPACITY` / `MCP_WRITE_RATE_LIMIT_REFILL_PER_SEC` | `10` / `0.2` |
| `MCP_TOOL_TIMEOUT_MS` | `20000` |
| `OAUTH_ENABLED` | `false` (on requires `MCP_PUBLIC_URL`, `OAUTH_ISSUER`, `OAUTH_SIGNING_JWK`) |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` / `OAUTH_GRANT_TTL_DAYS` | `3600` / `90` |
| `OAUTH_REFRESH_REUSE_GRACE_SECONDS` | `10` |
| `OAUTH_CIMD_ENABLED` / `OAUTH_DCR_ENABLED` | `true` / `true` |
| `OAUTH_DCR_EXTRA_REDIRECT_URIS` | unset |
| `OAUTH_AUTHORIZATION_SERVER` | unset (the built-in server; set: an external server's issuer, resource server only) |
| `OAUTH_JWKS_URL` | unset (the external server's metadata `jwks_uri`) |
| `OAUTH_LINK_MAX_AGE_DAYS` | `30` (how long after the identity service last vouched for someone in an account a sign-in still reaches it) |

## Check it yourself

`pnpm run build:packages && cd apps/api && pnpm e2e:mcp` boots the API the way the
production image does (tsx with `tsconfig.runtime.json`) on a throwaway SQLite
file and drives it with the official client: tool list, slots, book, reschedule,
cancel, an anonymous public booking, a legacy `initialize` handshake.

`pnpm e2e:mcp-login` does the same with an external authorization server: a
stand-in server (RS256 keys made by the script, its metadata and JWKS on a
loopback port) mints the tokens, and the script checks discovery, the dormant
built-in server, the 401 challenge, the 403 for a sign-in linked to no member,
whoami, list_my_accounts, list_event_types and a booking with a sign-in, and a
sign-in reaching two accounts.

`pnpm e2e:oauth` does the same for OAuth with the web app built for production
and a headless browser: discovery, the 401 challenge, registration, the real
login and consent pages, the code exchange with PKCE, tool calls with the token,
the 403 step-up, refresh rotation, a denied request, Claude Code's real metadata
document (when the network allows), Disconnect from Connected apps, and the 401
once the access token expires.
