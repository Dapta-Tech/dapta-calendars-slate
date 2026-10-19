/**
 * Central environment schema (zod). Validated once at server startup; fails
 * loud on a missing *required* production var, never silently. A bare fork with
 * NOTHING set must still boot — so every var has a safe default that selects the
 * zero-infra path (SQLite, log-only email, local auth).
 *
 * `NEXT_PUBLIC_*` client vars are validated separately (see `clientEnvSchema`)
 * because only they may cross into the browser bundle — a server secret in a
 * client bundle is a leak.
 */
import { z } from 'zod';

/** Coerce common truthy/falsey strings to boolean. */
const boolish = z
  .string()
  .transform((v) => v === 'true' || v === '1' || v === 'yes')
  .pipe(z.boolean());

/**
 * An optional secret where an empty value means unset. Deploy tooling often
 * renders a missing secret as `NAME=` rather than leaving it out, and a
 * minimum length would otherwise refuse that empty string and stop the app
 * from booting, when the documented meaning of "not set" is "feature off".
 */
const optionalSecret = (minLength: number) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(minLength).optional());

/**
 * A positive-number knob where an empty value means "use the default". Same
 * reason as `optionalSecret`: a deploy that renders a missing var as `NAME=`
 * must not stop the API from booting.
 */
const blankIsDefault = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database — unset selects SQLite (zero-infra). `file:` = SQLite, `postgres://` = pg.
  DATABASE_URL: z.string().default('file:./.data/dev.db'),

  // API
  API_PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

  // Email / notifications
  EMAIL_PROVIDER: z.enum(['log-only', 'noop', 'smtp', 'http']).default('log-only'),
  MAIL_FROM_EMAIL: z.string().default('bookings@example.com'),
  MAIL_FROM_NAME: z.string().default('Calendars'),
  // The support address booking emails name in their footer ("Need help?
  // <address>"). UNSET (a bare fork) prints no such line: an email must never
  // send a fork's readers to someone else's support desk. Not `.email()` on
  // purpose, and an empty value counts as unset: a malformed value must never
  // stop the API booting; the renderer drops anything that is not a bare
  // address.
  MAIL_SUPPORT_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  // SMTP adapter
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: boolish.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // HTTP mailer adapter (EMAIL_PROVIDER=http).
  EMAIL_HTTP_ENDPOINT: z.string().url().optional(),
  // Wire/profile: `generic` (default, provider-agnostic body + Bearer auth) or
  // `transactional-v1` (managed transactional contract + HMAC service auth).
  EMAIL_HTTP_PROFILE: z.enum(['generic', 'transactional-v1']).default('generic'),
  // Bearer token — `generic` profile.
  EMAIL_HTTP_TOKEN: z.string().optional(),
  // Stable non-secret service id and server-only HMAC secret. The secret is
  // loaded from the deployment secret manager and is never transmitted.
  EMAIL_HTTP_CLIENT_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  EMAIL_HTTP_SIGNING_SECRET: optionalSecret(32),
  // DEPRECATED: pre-HMAC static service key. Still read (never-break-env-vars)
  // as a Bearer fallback on the transactional wire; migrate to the pair above.
  EMAIL_HTTP_API_KEY: z.string().optional(),
  // Message category for `transactional-v1` (defaults to `lifecycle`).
  EMAIL_HTTP_CATEGORY: z.string().optional(),

  // Premium features (vanity slug + future perks). Calendars is ALWAYS free —
  // `locked` gates premium on the customer's Dapta AI subscription via the
  // entitlement service below; `open` (default) unlocks everything, so a bare
  // OSS fork gets every feature with no upstream wired.
  PREMIUM_FEATURES: z.enum(['open', 'locked']).default('open'),
  // Upstream entitlement service (cloud only): base URL + service key. Unset
  // selects the disabled provider (OSS default).
  ENTITLEMENTS_API_URL: z.string().url().optional(),
  ENTITLEMENTS_API_KEY: z.string().optional(),

  // Onboarding cohort probe (ADR 0002 / #65). UNSET disables gate 1 entirely:
  // the qualification questions feed a growth funnel, and with no upstream there
  // is no funnel, so a bare fork's first admin is never asked them. Set, the
  // identity service is asked whether this signup is already a known identity —
  // a hit selects the `dapta` cohort (2 questions), a definitive miss `cold`
  // (all 6). Any error or timeout FAILS CLOSED to `dapta`, the cohort that asks
  // less. URL-only — never a hardcoded host (publish gate).
  ONBOARDING_IAM_BASE_URL: z.string().url().optional(),
  ONBOARDING_IAM_TOKEN: z.string().optional(),
  // Deliberately short: this probe sits in front of a first-run wizard, so a
  // slow upstream must degrade to "ask less" quickly rather than stall a signup.
  ONBOARDING_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),

  // O2 growth — the contact sync into the OPERATOR'S OWN marketing CRM
  // (#94/#65). Not the customer-facing CRM integration a host connects to their
  // own account (#63): different system, different purpose. UNSET sends nothing
  // — the outbox rows are still enqueued and the worker records them as
  // skipped, so a fork reports nothing anywhere and nothing accumulates as
  // failures. URL-only, never a hardcoded host or flow id (publish gate).
  DAPTA_SYNC_URL: z.string().url().optional(),
  DAPTA_SYNC_TOKEN: z.string().optional(),
  // Bounded so a slow marketing endpoint can never hold an outbox worker tick.
  DAPTA_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Auth — unset selects the local dev stub.
  AUTH_PROVIDER: z.enum(['local', 'workos']).default('local'),

  // DEV ONLY — which host the local stub logs in as. When AUTH_PROVIDER=local
  // and this is set (or an `x-slate-email` header is sent), the stub resolves
  // the member with this email, JIT-creating a fresh account+member if none
  // exists — so a developer lands in THEIR own workspace instead of the first
  // seeded demo account. Ignored in production (the stub refuses to boot there).
  DEV_LOGIN_EMAIL: z.string().optional(),

  // DEV ONLY — when true, the local stub does NOT fall back to the seeded/
  // DEV_LOGIN_EMAIL account: a request with no identity (no impersonation
  // headers, no `x-slate-email`) resolves to 401 UNAUTHENTICATED. This gives
  // local dev a real "logged out" state so a web login/logout flow can bounce
  // to the sign-in screen (mirrors the old app). Default false keeps OSS
  // clone-and-run frictionless (always logged in, zero auth setup).
  AUTH_LOCAL_STRICT: boolish.optional(),

  // Host-session token (validated by the `workos` provider). The dashboard token
  // is an HS256 JWT minted by the upstream identity service (a shared symmetric
  // secret — so the SAME validation runs identically in local dev and remote).
  // All optional here: a bare OSS fork sets nothing and stays on `local`. The
  // provider fails loud if `workos` is selected without JWT_SECRET. Issuer/
  // audience are enforced ONLY when set (leave the vendor's real values to
  // deploy config / a local .env — never hardcoded in this public schema).
  JWT_SECRET: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),

  // Email domain of the platform operator's own staff (e.g. `@example.com`,
  // leading dot/at included). A login from this domain that lands in a customer
  // account it has never visited is provisioned as `admin` rather than `member`,
  // so an operator sent in to configure or support an account can see what is
  // there instead of an empty one. Everyone else keeps the normal rule: the
  // first member of an account owns it, later arrivals are `member`.
  //
  // Unset in a bare fork, and that is the safe default — no domain is special,
  // nobody is let in. Whoever sets it is asserting that the upstream identity
  // service will not mint a token for an address at this domain that the
  // operator does not control, which is the same assertion their own admin
  // tooling already rests on.
  OPERATOR_EMAIL_DOMAIN: z.string().optional(),

  // Calendar — `disabled` (default) runs with no external calendar: slots
  // subtract only local busy and no events are written out. `external` selects
  // the concrete generic-HTTP adapter (`ExternalCalendarProvider`); selecting it
  // without a backend configured (below) fails loud rather than silent-disabling.
  CALENDAR_PROVIDER: z.enum(['disabled', 'external']).default('disabled'),

  // External calendar backend (only read when CALENDAR_PROVIDER=external). The
  // adapter speaks a generic REST contract to CALENDAR_API_BASE_URL, authorized
  // by a bearer. Two ways to supply the bearer + request shaping:
  //   - Self-host / simple REST backend: set CALENDAR_API_TOKEN (a static bearer)
  //     and the committed GenericRestWire is used.
  //   - Real integration platform: set CALENDAR_BACKEND_MODULE to a PRIVATE
  //     overlay module (gitignored, e.g. under deploy/) that default-exports a
  //     factory `(env) => { baseUrl, tokenSource, wire }` — the JWT authority +
  //     vendor request mapping live there, never in this public build (R15).
  // Base URL / token / module path are all left to deploy config or a local
  // .env — never hardcoded here (same rule as JWT_ISSUER/JWT_AUDIENCE).
  CALENDAR_API_BASE_URL: z.string().url().optional(),
  CALENDAR_API_TOKEN: z.string().optional(),
  CALENDAR_BACKEND_MODULE: z.string().optional(),
  CALENDAR_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Busy requests per second one API process may start for one host. The
   * calendar backend's own limit is per host across all replicas, so each
   * replica gets a share (two replicas: 2 each). Default 4, for one replica.
   */
  CALENDAR_BUSY_REQUESTS_PER_SECOND: z.coerce.number().int().positive().default(4),
  /**
   * The longest span, in days, of one busy request to the calendar backend. A
   * longer read is split into windows this long. Default 14, safe for a backend
   * that lists events (a long listing can come back short on a full calendar).
   * Raise it only when the backend answers a free/busy query, which is whole for
   * any span; then a 60-day read is one request per connection.
   */
  CALENDAR_BUSY_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * The display cache of busy reads (ADR 0009). Only reads that SHOW
   * availability use it; holds, bookings, reschedules and confirmations always
   * read the calendar fresh. TTL: how long one read answers every visitor of
   * the same calendar (0 turns the cache off and every page view reads the
   * calendar, as before). MAX_STALE: how old the last good read may be and
   * still stand in when a fresh read fails; older, the times are withheld.
   * MAX_ENTRIES: windows held per process, least recently used out first.
   * READ_TIMEOUT: how long a page waits on a slow calendar before answering
   * from the last good read, or saying the calendar cannot be read right now.
   * All optional; the defaults suit one or many replicas.
   */
  CALENDAR_BUSY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
  CALENDAR_BUSY_CACHE_MAX_STALE_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  CALENDAR_BUSY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(1000),
  CALENDAR_BUSY_READ_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  // Display name for the conferencing the connected backend mints, shown to the
  // host when they pick the `conferencing` location kind. Deploy config only —
  // this repo names no conferencing vendor (R15, ADR 0008). Unset ⇒ the UI shows
  // generic wording, which is the correct default for a bare fork.
  CALENDAR_CONFERENCING_LABEL: z.string().max(60).optional(),

  // CRM write-out (H1a / #63 / ADR 0001). `disabled` (default) runs with no CRM
  // at all: nothing is enqueued and nothing is called, so a bare fork behaves
  // exactly as it did before the seam existed. `hubspot` selects the committed
  // adapter. Unlike the calendar seam, this one MAY name its vendor — R15
  // governs calendar vendors only; see docs/adr/0001-*.md.
  CRM_PROVIDER: z.enum(['disabled', 'hubspot']).default('disabled'),
  // Symmetric key for integration credentials at rest: 32 raw bytes, base64
  // (`openssl rand -base64 32`). Read ONLY when a credential is written or
  // read, so a deployment that never connects a CRM never needs one and boot is
  // unaffected. Connecting without it is REFUSED loudly rather than stored in
  // plaintext. Shared with #75 when webhook secrets move under the same envelope.
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
  // Zero-config fallback: one private-app token for the whole deployment, used
  // only by accounts that have connected nothing of their own. A connected
  // token always wins. Placeholder values are detected and treated as UNSET, so
  // an uncommented-but-unfilled .env line disables the integration rather than
  // 401-ing forever.
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  // Bounded so a slow CRM can never hold an outbox worker tick.
  CRM_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Where the CRM adapter sends its requests. Defaults to the vendor's own
  // public host, so nobody needs to set this. It exists for a self-hoster whose
  // egress runs through a proxy, and for exercising the integration end-to-end
  // against a stub — which is what keeps stubs out of product code. Mirrors
  // CALENDAR_API_BASE_URL.
  CRM_API_BASE_URL: z.string().url().optional(),

  // Outbox worker (B7/DM1): drains durable side-effects (calendar write-out,
  // webhook delivery) with retry+backoff. Enabled by default; the poll interval
  // and retry ceiling are tunable. Set OUTBOX_WORKER_ENABLED=false to run the
  // API without the background drainer (e.g. when a separate worker process owns
  // it). On a bare clone the queue is empty, so the worker just idles.
  OUTBOX_WORKER_ENABLED: boolish.default('true'),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(5000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /**
   * How long a failing delivery keeps being retried, counted from its first
   * failure: exponential backoff (1 s, 2 s, 4 s ... capped at 15 min, with
   * jitter), and once a row has spent its attempt budget AND been failing this
   * long it is marked failed and logged. Default 24 h, so a subscriber, mail
   * transport or calendar that is down for minutes or hours loses nothing.
   * 0 restores the old behaviour: give up when the attempt budget is spent.
   */
  OUTBOX_RETRY_HORIZON_MS: z.coerce.number().int().min(0).max(30 * 24 * 3_600_000).default(24 * 3_600_000),
  /**
   * Deliveries in flight at once, per kind of work (webhooks, emails, calendar
   * writes, CRM writes, sign-up sync), per process. Each kind drains on its
   * own; a booking's deliveries go one at a time in the order queued, and a
   * slow webhook subscriber holds at most one slot per process, so it holds
   * up only itself.
   */
  OUTBOX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /**
   * How long a claimed row belongs to the process that claimed it. Another
   * replica takes it over only after this, so it must outlast the slowest
   * delivery (a calendar write can make several backend calls). A replica that
   * dies mid-delivery has its rows picked up once the lease runs out.
   */
  OUTBOX_LEASE_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),

  // CORS: a comma-separated allowlist of origins permitted to call the API from
  // a browser. When UNSET we default to PUBLIC_APP_URL only (the app's own web
  // origin) — NOT reflect-any. To embed the public booking widget on other
  // domains, list them here, e.g. CORS_ORIGINS="https://acme.com,https://foo.io".
  CORS_ORIGINS: z.string().optional(),

  // Rate limiting (public booking/availability). A per-IP token bucket: burst up
  // to CAPACITY, sustained REFILL tokens/sec. Enabled by default; a fork can
  // disable it or plug a distributed limiter in the private overlay.
  RATE_LIMIT_ENABLED: boolish.default('true'),
  RATE_LIMIT_CAPACITY: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().positive().default(1),
  // How many reverse proxies in front of the API append to X-Forwarded-For. The
  // limiter keys on the address the NEAREST trusted proxy saw, counted from the
  // right of the header: the entries to its left are whatever the client sent
  // and can be rotated at will. 1 = one load balancer (the common deploy);
  // 2 = a CDN in front of that load balancer; 0 = no proxy, use the socket.
  RATE_LIMIT_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  // A secret shared with the web app (both read INTERNAL_API_SECRET). The web
  // calls the API server side on a visitor's behalf, so without it every
  // visitor of every booking page arrives from the web server's address and
  // shares one bucket. With it set on both, the web sends the visitor's address
  // beside the secret and the limiter keys on that address. Unset = off. A
  // forwarded address without the matching secret is ignored, so nobody else
  // who can reach the API can mint fresh buckets.
  INTERNAL_API_SECRET: optionalSecret(32),

  // One log line per request (method, route template, status, duration, request
  // id, error code, account). JSON when NODE_ENV=production, a human line
  // otherwise. Never carries query strings, bodies, headers or client addresses.
  REQUEST_LOG_ENABLED: boolish.default('true'),

  // --- Growth loop in booking emails ---
  // The signup destination the invitee's email footer links to ("Made with ...
  // Create your free calendar"), the API-side twin of the web's
  // NEXT_PUBLIC_SIGNUP_URL, which is also read here so one value set for both
  // apps is enough. Unset (a bare fork): the email names no product at all.
  // Not `.url()` on purpose: a malformed value must never stop the API booting;
  // `buildSignupUrl` drops anything that is not http(s).
  SIGNUP_URL: z.string().optional(),
  NEXT_PUBLIC_SIGNUP_URL: z.string().optional(),
  // Turns the footer line off even with a destination (same spellings as the
  // web's NEXT_PUBLIC_HIDE_BADGE, which is read as the fallback).
  HIDE_BADGE: z.string().optional(),
  NEXT_PUBLIC_HIDE_BADGE: z.string().optional(),

  // --- Product analytics (this deployment's OWN telemetry) ---
  // How hosts use the product and, anonymously, what visitors do on booking
  // pages; see `resolveAnalyticsConfig` (@slate/shared). OFF unless both a
  // provider (`posthog`, the one adapter shipped) and its write-only project
  // key are set; a bare fork sends nothing anywhere. Plain strings on purpose:
  // a mistyped value turns analytics off with a warning and never stops the
  // API booting. The web app reads the SAME names at request time, so one
  // value per deployment serves both apps and no image rebuild is needed.
  PRODUCT_ANALYTICS_PROVIDER: z.string().optional(),
  PRODUCT_ANALYTICS_KEY: z.string().optional(),
  // Ingestion host, e.g. the deployment's own reverse proxy. Unset = the
  // vendor's public host.
  PRODUCT_ANALYTICS_HOST: z.string().optional(),
  // Comma-separated, case-insensitive substrings of an email that mark the
  // operator's own people (staff, test accounts): `is_internal` on their
  // events, so launch numbers can leave them out. Unset = nobody is internal.
  PRODUCT_ANALYTICS_INTERNAL_EMAILS: z.string().optional(),

  // --- MCP endpoint (`POST /mcp`) -------------------------------------------
  // Every var here is optional with a safe default: unset, the endpoint serves
  // the public booking tools to anyone and the key-gated tools to API keys,
  // refuses browser origins, and rate limits per pod.
  //
  // On by default. `false` unmounts nothing but makes `/mcp` answer 404.
  MCP_ENABLED: boolish.default('true'),
  // The URL people paste into an agent (shown in docs and the web page). With
  // OAuth OFF it is only ever displayed, so a wrong value cannot lock anyone
  // out. With OAuth ON it is also the resource identifier: the audience of
  // every access token and the `resource` of the protected-resource metadata,
  // so it must be exactly the URL people paste, path included.
  MCP_PUBLIC_URL: blankIsDefault(z.string().url().optional()),
  // Comma-separated browser origins allowed to call `/mcp` (DNS-rebinding guard).
  // A request carrying an `Origin` header outside this list is refused with 403;
  // requests without one (every non-browser MCP client) are unaffected. Unset =
  // no browser origin is allowed. A browser-hosted client must also be listed in
  // CORS_ORIGINS, or the browser will not let the page read the answer.
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  // Comma-separated hostnames `/mcp` answers to (the `Host` header, port
  // ignored). Unset = no host check. Set it when the API is reachable under
  // names you do not control (DNS rebinding needs an attacker-chosen Host).
  MCP_ALLOWED_HOSTS: z.string().optional(),
  // Per-pod token buckets for tool calls, keyed by API key (or client address
  // for anonymous calls). Reads: burst CAPACITY, sustained REFILL per second.
  // Writes (book_meeting, create/reschedule/cancel) have their own, tighter pair.
  MCP_RATE_LIMIT_CAPACITY: blankIsDefault(z.coerce.number().int().positive().default(30)),
  MCP_RATE_LIMIT_REFILL_PER_SEC: blankIsDefault(z.coerce.number().positive().default(1)),
  MCP_WRITE_RATE_LIMIT_CAPACITY: blankIsDefault(z.coerce.number().int().positive().default(10)),
  MCP_WRITE_RATE_LIMIT_REFILL_PER_SEC: blankIsDefault(z.coerce.number().positive().default(0.2)),
  // How long one tool call may run before the caller gets a timeout error.
  MCP_TOOL_TIMEOUT_MS: blankIsDefault(z.coerce.number().int().min(1000).max(120_000).default(20_000)),

  // --- OAuth for the MCP endpoint (this API as its own authorization server) --
  // OFF by default, and a bare fork never needs it: API keys and the public
  // booking tools work without it. ON, the API serves an OAuth 2.1
  // authorization server under `/oauth` so chat apps (Claude, ChatGPT) and IDEs
  // connect with a sign-in and a consent screen instead of a pasted key. The
  // person signs in the way the dashboard already signs them in (the configured
  // AUTH_PROVIDER); nothing is registered with any identity vendor.
  //
  // Turning it on REQUIRES MCP_PUBLIC_URL (it becomes the token audience),
  // OAUTH_ISSUER and OAUTH_SIGNING_JWK; the API refuses to boot without them
  // rather than serve a half-configured authorization server.
  OAUTH_ENABLED: boolish.default('false'),
  // The public ORIGIN that serves `/oauth/*` and
  // `/.well-known/oauth-authorization-server` (scheme + host, no path), e.g.
  // https://calendar.example.com. It is the `iss` of every token and of every
  // authorization response, so it must never change once apps are connected.
  OAUTH_ISSUER: blankIsDefault(z.string().url().optional()),
  // The private signing key for access tokens: one EC P-256 JWK (ES256) as a
  // JSON string, with its private part `d`. Every replica holds the same key and
  // verifies tokens without a database read. A secret: deploy it like one.
  OAUTH_SIGNING_JWK: optionalSecret(1),
  // Access-token lifetime. Short on purpose: a revoked connection keeps working
  // until its last access token expires.
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: blankIsDefault(z.coerce.number().int().min(60).max(86_400).default(3600)),
  // Absolute lifetime of a connection (its grant and refresh tokens). Refresh
  // rotation never extends it; after this the person connects again.
  OAUTH_GRANT_TTL_DAYS: blankIsDefault(z.coerce.number().int().min(1).max(365).default(90)),
  // A rotated refresh token presented again within this many seconds is treated
  // as a client retry (a lost response), not a theft. Later than that, reuse
  // revokes the whole connection. 0 = strict.
  OAUTH_REFRESH_REUSE_GRACE_SECONDS: blankIsDefault(z.coerce.number().int().min(0).max(60).default(10)),
  // Client ID Metadata Documents (the client's id is an https URL we fetch).
  // What Claude and ChatGPT prefer. On by default when OAuth is on.
  OAUTH_CIMD_ENABLED: boolish.default('true'),
  // Dynamic Client Registration (`POST /oauth/register`), the fallback Cursor
  // and VS Code still need. Restricted to a fixed list of redirect addresses.
  OAUTH_DCR_ENABLED: boolish.default('true'),
  // Comma-separated EXACT redirect URIs added to the registration allowlist,
  // for a client this deployment trusts that is not on the built-in list.
  OAUTH_DCR_EXTRA_REDIRECT_URIS: z.string().optional(),

  // --- OAuth for the MCP endpoint (an external authorization server) ---------
  // With OAUTH_ENABLED=true and this set, the API is a resource server ONLY:
  // sign-in, consent and tokens belong to this external OAuth 2.1 authorization
  // server, and the built-in one above is not mounted (its routes answer 404,
  // and OAUTH_ISSUER / OAUTH_SIGNING_JWK are not needed). The value is the
  // server's issuer, an origin (scheme and host), exactly as its metadata and
  // its tokens write it. The server must support RFC 8707 resource indicators
  // (tokens for MCP_PUBLIC_URL carry it as their audience) and publish a JWKS.
  // Unset: the built-in server runs as configured above.
  OAUTH_AUTHORIZATION_SERVER: blankIsDefault(z.string().url().optional()),
  // Where that server publishes its signing keys. Unset: the `jwks_uri` of its
  // metadata (`<issuer>/.well-known/oauth-authorization-server`).
  OAUTH_JWKS_URL: blankIsDefault(z.string().url().optional()),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

/** Parse + validate server env, throwing a readable error on misconfiguration. */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Fail loud: the `local` auth backend is an unauthenticated dev stub and must
  // never serve production. A fork has to consciously opt into a real provider
  // (WorkOS overlay) — we refuse to boot rather than silently run wide open.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.AUTH_PROVIDER === 'local') {
    throw new Error(
      'Refusing to boot: AUTH_PROVIDER=local is an unauthenticated development stub and cannot run in ' +
        'production. Set AUTH_PROVIDER=workos (with the private auth overlay) or another real provider.',
    );
  }
  const oauth = oauthConfigProblems(parsed.data);
  if (oauth.length > 0) {
    throw new Error(`Refusing to boot: OAUTH_ENABLED=true but the authorization server is not configured:\n${oauth.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}

/** Loopback hosts a development deployment may serve over plain http. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or http on a loopback host outside production. */
function secureEnough(url: URL, env: Pick<ServerEnv, 'NODE_ENV'>): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && env.NODE_ENV !== 'production' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Who signs MCP connections in: nobody (OAuth off), this API's own
 * authorization server, or an external one this API only checks tokens from.
 */
export type OAuthMode = 'off' | 'builtin' | 'external';

export function oauthMode(env: Pick<ServerEnv, 'OAUTH_ENABLED' | 'OAUTH_AUTHORIZATION_SERVER'>): OAuthMode {
  if (!env.OAUTH_ENABLED) return 'off';
  return env.OAUTH_AUTHORIZATION_SERVER ? 'external' : 'builtin';
}

/**
 * Everything wrong with the OAuth settings, as sentences an operator can act
 * on; empty when OAuth is off or correctly configured. Fail-fast lives in
 * `loadServerEnv`; this is split out so it can be tested without throwing.
 * The signing key is checked for SHAPE here (config stays dependency-free);
 * the API imports it at boot and refuses a key that does not load.
 */
export function oauthConfigProblems(env: ServerEnv): string[] {
  if (!env.OAUTH_ENABLED) return [];
  const problems: string[] = [];
  if (!env.MCP_ENABLED) problems.push('MCP_ENABLED must be true: the authorization server only protects the MCP endpoint.');
  if (!env.MCP_PUBLIC_URL) {
    problems.push('MCP_PUBLIC_URL is required: it is the resource every access token is issued for (its audience).');
  } else {
    const mcp = new URL(env.MCP_PUBLIC_URL);
    if (!secureEnough(mcp, env)) problems.push('MCP_PUBLIC_URL must use https (http only on localhost outside production).');
    if (mcp.search || mcp.hash) problems.push('MCP_PUBLIC_URL must not carry a query string or a fragment.');
  }
  if (env.OAUTH_AUTHORIZATION_SERVER) {
    // Resource server only: the built-in server's issuer and key are unused.
    const as = new URL(env.OAUTH_AUTHORIZATION_SERVER);
    if (!secureEnough(as, env)) problems.push('OAUTH_AUTHORIZATION_SERVER must use https (http only on localhost outside production).');
    if ((as.pathname !== '/' && as.pathname !== '') || as.search || as.hash || as.username || as.password)
      problems.push('OAUTH_AUTHORIZATION_SERVER must be an origin only (scheme and host, no path, query, fragment or credentials).');
    if (env.OAUTH_JWKS_URL) {
      const jwks = new URL(env.OAUTH_JWKS_URL);
      if (!secureEnough(jwks, env)) problems.push('OAUTH_JWKS_URL must use https (http only on localhost outside production).');
      if (jwks.hash || jwks.username || jwks.password) problems.push('OAUTH_JWKS_URL must not carry a fragment or credentials.');
    }
    return problems;
  }
  if (!env.OAUTH_ISSUER) {
    problems.push('OAUTH_ISSUER is required: the public origin that serves /oauth/* (for example https://calendar.example.com).');
  } else {
    const issuer = new URL(env.OAUTH_ISSUER);
    if (!secureEnough(issuer, env)) problems.push('OAUTH_ISSUER must use https (http only on localhost outside production).');
    if ((issuer.pathname !== '/' && issuer.pathname !== '') || issuer.search || issuer.hash)
      problems.push('OAUTH_ISSUER must be an origin only (scheme and host, no path, query or fragment).');
  }
  if (!env.OAUTH_SIGNING_JWK) {
    problems.push('OAUTH_SIGNING_JWK is required: an EC P-256 private JWK (ES256) as a JSON string.');
  } else {
    let jwk: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(env.OAUTH_SIGNING_JWK);
      if (value && typeof value === 'object' && !Array.isArray(value)) jwk = value as Record<string, unknown>;
    } catch {
      /* reported below */
    }
    if (!jwk) problems.push('OAUTH_SIGNING_JWK is not a JSON object.');
    else if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string')
      problems.push('OAUTH_SIGNING_JWK must be an EC P-256 PRIVATE key (kty "EC", crv "P-256", with x, y and d).');
  }
  return problems;
}

/** True when DATABASE_URL points at Postgres (vs SQLite). */
export function isPostgresUrl(url: string): boolean {
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}
