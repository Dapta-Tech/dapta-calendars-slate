# Self-hosting Dapta Calendars

Dapta Calendars is **deployment-agnostic**: two Node apps (a Next.js web frontend
and a NestJS API) plus a database. No host-only APIs, no managed-platform lock-in —
anywhere Node ≥ 20 or Docker runs, it runs. This guide takes you from a clean host
to a running, double-booking-safe production deployment.

For the architecture behind these choices, read [`ARCHITECTURE.md`](ARCHITECTURE.md);
for local development, [`CLAUDE.md`](CLAUDE.md) and the `.claude/skills/local-dev`
skill.

## What you get

- A **public booking page** (`/[accountCode]/[handle]/[slug]`) that server-renders
  real availability and books it, double-booking-safe.
- An **admin dashboard + studio** to manage event types, availability, teams, and
  booking-page branding.
- A **pure scheduling engine**, one **portable schema** over SQLite/Postgres, and
  **hexagonal seams** for auth, calendar sync, email, and entitlements — each with a
  safe default so nothing external is required to start.

## Prerequisites

- **Node ≥ 20** and **pnpm ≥ 10** (only if you build from source), or **Docker +
  Docker Compose** (if you deploy the prebuilt images).
- A **PostgreSQL 14+** database for production (SQLite is dev-only — see below).
- A TLS-terminating reverse proxy (nginx, Caddy, Traefik, or a cloud load
  balancer) in front of both apps.

## Quickest production deploy (Docker Compose)

The repo ships [`docker-compose.prod.yml`](docker-compose.prod.yml) — **read it
first**; it is the reference wiring and a real smoke test. It builds the same two
images that ship to production, runs database migrations **once** via a one-shot
`migrate` service, then starts the API and web against a local Postgres:

```bash
# A password is required; everything else has a safe default.
POSTGRES_PASSWORD=<a-strong-password> \
DATABASE_URL=postgres://slate:<a-strong-password>@db:5432/slate \
docker compose -f docker-compose.prod.yml up --build
# → http://localhost:3000 (web)   http://localhost:4000/health (api)
```

Notes carried straight from that file:

- Migrations run in the **one-shot `migrate` service** before the API starts —
  never baked into the long-running pod, so scaling never races migrators.
- The committed image ships two auth providers: `local` (an unauthenticated **dev
  stub**) and `workos` (a generic HS256-JWT provider). The API **refuses the stub
  under `NODE_ENV=production`**, so the smoke-test stack runs
  `NODE_ENV=development` by default. For a real deployment set
  `NODE_ENV=production` **and** a real provider together (see Auth options).
- `NEXT_PUBLIC_API_URL` is **inlined into the web client bundle at build time** (a
  Docker `--build-arg`), not read at runtime. If your API is at
  `https://calendars-api.example.com`, build the web image with that value.

Use `docker-compose.prod.yml` as the template for your orchestrator (Compose,
Kubernetes, Nomad, a PaaS) — the two images and the migrate-then-serve ordering are
what matter.

## Building the two images

```bash
# API — Node/tsx runtime
docker build -f apps/api/Dockerfile -t calendars-api:local .

# Web — Next.js standalone. NEXT_PUBLIC_* are build-time-inlined, so pass them here.
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://calendars-api.example.com \
  -t calendars-web:local .
```

The build context is the **repo root** for both (they are pruned monorepo bundles).
Push to any registry your runtime pulls from.

## Database

**Postgres is the source of truth.** SQLite is a zero-infra convenience for local
development only — it has the app-level double-booking guard but not the physical
`EXCLUDE` constraint, so **never run production on SQLite**. Select the dialect with
`DATABASE_URL`:

- `postgres://<user>:<password>@<host>:5432/<database>` → Postgres
- `file:./.data/dev.db` (or unset) → SQLite (dev)

### Running migrations

Migrations are numbered SQL files under `packages/db/migrations/{postgres,sqlite}/`.
Apply pending migrations against your `DATABASE_URL`:

```bash
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database> pnpm db:migrate
```

In Docker, the `migrate` one-shot service in `docker-compose.prod.yml` does this for
you before the API boots. On Kubernetes, run migrations as an init-container or a
one-shot Job — not inside the long-running API pod.

The Postgres schema needs the **`btree_gist`** extension (for the
`booking_no_overlap` `EXCLUDE` constraint). The migration creates it; if your
database role cannot `CREATE EXTENSION`, have a superuser run
`CREATE EXTENSION IF NOT EXISTS btree_gist;` once per database first.

### Additive-only policy

Schema changes are **additive**: new nullable columns or new tables, never a
destructive rename or drop. This means migrations are safe to run against a live
database during a rolling deploy, and an older pod keeps working while a newer one
starts. Keep your own forks to the same rule.

## Full environment reference

Every variable, its default, when it is required, and whether it is a secret. The
authoritative source is `packages/config/src/env.ts`; a bare clone with **nothing
set** boots on the zero-infra path.

### Core

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `NODE_ENV` | `development` | set `production` for any real deploy | no |
| `DATABASE_URL` | `file:./.data/dev.db` | always in production (a `postgres://` URL) | **yes** (contains DB password) |
| `API_PORT` | `4000` | — | no |
| `PUBLIC_APP_URL` | `http://localhost:3000` | production (used to build manage/booking links, and the host's "Confirm or decline" button, which opens `/admin/bookings` there) | no |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | production; **build-time** for web | no |

### Auth (dashboard only — public booking pages are always open)

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `AUTH_PROVIDER` | `local` | production must use a real provider (e.g. `workos`) | no |
| `JWT_SECRET` | — | required when `AUTH_PROVIDER=workos` | **yes** |
| `JWT_ISSUER` | — | optional; enforced only when set | no |
| `JWT_AUDIENCE` | — | optional; enforced only when set | no |
| `DEV_LOGIN_EMAIL` | — | dev only (ignored in production) | no |
| `AUTH_LOCAL_STRICT` | `false` | dev only | no |
| `WEB_SESSION_SECRET` | (unsigned dev cookie) | set for any real deploy so the session cookie can't be forged | **yes** |
| `OPERATOR_EMAIL_DOMAIN` | — | only if you run this for other people's accounts | no |

`OPERATOR_EMAIL_DOMAIN` names your own staff (`@your-company.example`). A login
from that domain lands in a customer's account as `admin` instead of `member` —
otherwise they see an empty account and cannot help — and gets an account picker
in the admin sidebar so they can reach that customer without signing out. The
identity service still decides every switch, so this only changes what is
offered. Unset, nobody is special; set it only if your identity service cannot
mint a token for an address at that domain you do not control.

### Calendar (external free-busy + event write-out)

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `CALENDAR_PROVIDER` | `disabled` | set `external` to sync an external calendar | no |
| `CALENDAR_API_BASE_URL` | — | required for the generic REST backend | no |
| `CALENDAR_API_TOKEN` | — | required for the generic REST backend | **yes** |
| `CALENDAR_BACKEND_MODULE` | — | optional; absolute path to a private backend module | no |
| `CALENDAR_HTTP_TIMEOUT_MS` | `30000` | — | no |
| `CALENDAR_BUSY_REQUESTS_PER_SECOND` | `4` | — | no (busy requests one API process starts per second for one host; with N replicas give each its share) |
| `CALENDAR_BUSY_WINDOW_DAYS` | `14` | optional; longest span of one busy request, 1 to 90 days. Raise it above 14 ONLY when your calendar adapter reads busy times from a free/busy query. With an events listing, a long window comes back short on a full calendar and offers times that are taken | no |
| `CALENDAR_CONFERENCING_LABEL` | — | optional; display name for the conferencing your backend mints, shown to hosts. Unset ⇒ generic wording | no |
| `CALENDAR_BUSY_CACHE_TTL_MS` | `30000` | optional; how long one busy read answers every visitor of the same calendar on the booking, team and manage pages (0 turns the cache off). Holds, bookings, reschedules and confirmations always read the calendar fresh (ADR 0009) | no |
| `CALENDAR_BUSY_CACHE_MAX_STALE_MS` | `300000` | optional; when a fresh read fails or is slow, how old the last good read may be and still stand in. Older, the page says the calendar can't be read right now and offers nothing | no |
| `CALENDAR_BUSY_CACHE_MAX_ENTRIES` | `1000` | optional; read windows held per API process, least recently used out first | no |
| `CALENDAR_BUSY_READ_TIMEOUT_MS` | `10000` | optional; how long a page waits on a slow calendar before answering from the last good read (or saying it can't be read). The read keeps going and fills the cache for the next visitor | no |

The busy cache is per API process. A booking clears the cached reads of its
hosts on the process that took it; other replicas catch up within the TTL. It
only ever feeds what a page shows: every write re-reads the calendar for the
exact time and refuses (`SLOT_TAKEN`, or `CALENDAR_UNAVAILABLE` with
`Retry-After` when the calendar cannot be read) rather than trust a cached
answer. When a read is served stale or fails, the API logs one line per
connection per minute (`busy cache: event=stale_served|read_failed conn=<hash>
...`), naming the connection by a short hash, never its ref.

### Email / notifications

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `EMAIL_PROVIDER` | `log-only` | set `smtp` or `http` to actually send | no |
| `MAIL_FROM_EMAIL` | `bookings@example.com` | production | no |
| `MAIL_FROM_NAME` | `Calendars` | — | no |
| `MAIL_SUPPORT_EMAIL` | unset | optional; the address booking emails name in their footer ("Need help? support@example.com"). Unset ⇒ no support line, so a fork never sends its readers to another deployment's support desk. Anything that is not a bare address is ignored | no |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | — | when `EMAIL_PROVIDER=smtp` | `SMTP_PASS` **yes** |
| `EMAIL_HTTP_ENDPOINT` | — | when `EMAIL_PROVIDER=http` | no |
| `EMAIL_HTTP_PROFILE` | `generic` | `transactional-v1` opts into the managed contract | no |
| `EMAIL_HTTP_TOKEN` | — | `generic` profile Bearer auth | **yes** |
| `EMAIL_HTTP_CLIENT_ID` | — | `transactional-v1` client id | no |
| `EMAIL_HTTP_SIGNING_SECRET` | — | `transactional-v1` HMAC signing (min 32 chars) | **yes** |
| `EMAIL_HTTP_CATEGORY` | `lifecycle` | `transactional-v1` | no |

### Entitlements (premium perks — Calendars is always free)

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `PREMIUM_FEATURES` | `open` | keep `open` for a self-host (everything unlocked) | no |
| `ENTITLEMENTS_API_URL` | — | only when `PREMIUM_FEATURES=locked` | no |
| `ENTITLEMENTS_API_KEY` | — | only when `PREMIUM_FEATURES=locked` | **yes** |

### Onboarding cohort probe (first-run wizard)

**Leave all three unset for a self-host.** The qualification questions exist to
feed a growth funnel; with no upstream identity service there is no funnel, so
the whole gate is skipped and your first admin goes straight to the dashboard.
A self-hoster is never asked which CRM their team uses.

The per-host setup step still runs — it creates your first event type from a
template, which is what makes your booking page show something — and it carries
a "Skip for now".

With a probe configured, the service is asked whether the signup is an identity
it already knows: a hit selects the short cohort, a definitive `404` the full
one. **Any error or timeout fails closed to the short cohort**, so an upstream
outage never widens the interrogation of a real signup.

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `ONBOARDING_IAM_BASE_URL` | — | only to enable the probe (unset = ask the full bank) | no |
| `ONBOARDING_IAM_TOKEN` | — | only when the probe endpoint requires a bearer | **yes** |
| `ONBOARDING_PROBE_TIMEOUT_MS` | `1500` | never — raise only if the probe legitimately runs slow | no |

### Growth contact sync

**Unset by default, and a fork that leaves it unset sends nothing anywhere.**

When a deployment wants to know who signed up and where they came from, two
things happen, both optional and both env-gated.

**Attribution needs no configuration at all.** A visitor arriving with campaign
parameters has them normalized against a fixed allowlist — `utm_source`,
`utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `fbclid`, and
nothing else — parked in a ten-minute httpOnly cookie, and claimed **write-once**
onto their account if that account is younger than ten minutes. Values are
trimmed, capped, and the five `utm_*` lowercased; click ids keep their case. The
referrer is read from the request header and only when it is cross-origin, never
from a query parameter, because a caller-supplied one is attacker-controlled
text that could never be distinguished from the real thing once stored.

**Organic traffic records nothing.** There is no synthetic `utm_source=direct`.
The claim can never be undone, so a guess written there is wrong forever.

**The contact push** is what actually leaves the building, and it needs
`DAPTA_SYNC_URL`. It is enqueued to the outbox and drained by the worker, never
sent inline from a request, so a CRM outage cannot slow or fail a signup. It
fires twice for a self-serve signup — once on their first onboarding answer, so
someone who abandons the wizard is still recorded, and once when qualification
completes — and once for an invited member, when their membership row is created.
An invited member carries `entry_type: workspace_invite` in a field of its own
and never a `lead_source`, so an invitation cannot overwrite better attribution
on a contact who already existed, and no lead score is computed for someone who
answered no questions.

With `DAPTA_SYNC_URL` unset the rows are still enqueued and the worker marks
them **skipped** with a reason. That is deliberate: nothing is sent, nothing is
retried against a URL that does not exist, and the delivery log says plainly why.
A member with no email address is skipped the same way, permanently — there is
no key to upsert them by, and waiting cannot produce one.

**What a visitor's browser stores.** Capturing attribution sets one httpOnly
cookie, for ten minutes, on any page a visitor reaches carrying campaign
parameters or a cross-origin referrer — public booking pages included. It is
server-only, never readable from page scripts, never sent anywhere outside your
deployment, and it is deleted as soon as it is claimed or when it expires. It
holds only the allowlisted values above. If your jurisdiction or your policy
requires consent before any non-essential cookie, gate the middleware behind
whatever consent signal you already collect.

The lead-score post reuses `ONBOARDING_IAM_BASE_URL` from the section above, so
there is one upstream identity service and one pair of credentials.

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `DAPTA_SYNC_URL` | — | only to enable the contact push (unset = send nothing) | no |
| `DAPTA_SYNC_TOKEN` | — | only when that endpoint requires a bearer | **yes** |
| `DAPTA_SYNC_TIMEOUT_MS` | `5000` | never — raise only if the endpoint legitimately runs slow | no |

### Product analytics (optional)

**Off by default, and a fork that leaves it unset loads no script, enqueues
nothing and makes no request.**

Set a provider and its project key and the deployment reports how it is used
to an analytics project you own: hosts' activation steps (signup and its
source, template, calendar connected, hours, first publish, branding) as server
events, plus dashboard pageviews; and, anonymously, the booking funnel on public
pages (page viewed, day picked, time picked, booking sent and confirmed, a click
on the "Made with" badge). The full event list and what is never sent are in
[`ANALYTICS.md`](ANALYTICS.md).

The short version of the privacy model: hosts are identified by email; visitors
never are. A visitor gets no person profile, nothing is written to their device,
and nothing they type is sent. Session recording and autocapture are off on
every page. URLs lose their query strings before they leave the browser.

**One image, any environment.** The web app reads these variables on the server
**at request time**, not as `NEXT_PUBLIC_*` build arguments, so the same image
can run with analytics on, off, or pointed at a different project per
environment. Set them on **both** apps; the names are the same.

`posthog` is the one adapter in this repository. The host may be PostHog's own
(`https://us.i.posthog.com`, the default) or your reverse proxy in front of it.
The browser loads the library from `<host>/static/array.js` (for PostHog's own
hosts, from their assets host: `https://us-assets.i.posthog.com/static/array.js`)
and sends events to the host itself; allow both in a Content-Security-Policy
(`script-src` and `connect-src`). No inline script is added. The vendor sees
the client's IP address from the request itself: if your policy calls for it,
turn on your project's "discard client IP" setting.

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `PRODUCT_ANALYTICS_PROVIDER` | unset (off) | to enable: `posthog` | no |
| `PRODUCT_ANALYTICS_KEY` | unset | to enable: the project's write-only ingestion key | no (it reaches the browser by design) |
| `PRODUCT_ANALYTICS_HOST` | the vendor's public host | only to use your own proxy or region | no |
| `PRODUCT_ANALYTICS_INTERNAL_EMAILS` | unset | only to mark your own staff and test accounts `is_internal`: comma-separated, case-insensitive substrings of an email | no |

A provider without a usable key or host turns analytics off with one warning at
boot; it never stops either app from starting. Turning analytics off later
leaves any queued rows to drain as `skipped`.

**What a visitor's browser stores.** Nothing, from analytics itself. The one
cookie this feature adds is `slate.ph_id`: when a link to one of the product's
own entry points (`/`, `/login`, `/onboarding`, `/admin`) arrives carrying
`?ph_id=` (a marketing landing's anonymous id), the middleware parks it for ten
minutes, httpOnly, beside the campaign cookie above, so the host who signs up
can be joined to their landing visit. It is never set on a booking page, only
when the value looks like an analytics id, and never read unless analytics is on.

### CRM write-out (optional)

Writes an accepted booking into the CRM your hosts already work in: the invitee
becomes a contact (an existing one keeps its own name) and the booking becomes a
meeting associated to it, PATCHed on cancel and reschedule. This is the
**customer-facing** integration a workspace connects to its own portal — not the
operator's own growth sync above.

Unset (`disabled`) means nothing is enqueued and nothing is called. Naming the
vendor here is deliberate: [ADR 0001](docs/adr/0001-crm-integrations-are-open-core-and-name-their-vendor.md)
carves CRM out of the vendor-neutral rule, which governs **calendar** providers only.

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `CRM_PROVIDER` | `disabled` | set to `hubspot` to enable the write-out | no |
| `INTEGRATION_ENCRYPTION_KEY` | — | to CONNECT a credential, or to CREATE a webhook; boot never reads it | **yes** |
| `HUBSPOT_PRIVATE_APP_TOKEN` | — | only as a deployment-wide fallback for accounts that connect nothing | **yes** |
| `CRM_HTTP_TIMEOUT_MS` | `10000` | never — raise only if the CRM legitimately runs slow | no |

`INTEGRATION_ENCRYPTION_KEY` is 32 raw bytes, base64 — generate one with
`openssl rand -base64 32`. Credentials are stored AES-256-GCM encrypted under a
`v1.<iv>.<tag>.<ciphertext>` envelope bound to `(account, provider)`, so a
ciphertext lifted from one account's row cannot be opened in another's. **Losing
this key means every stored credential must be re-pasted**; rotating it requires
re-connecting each integration, since nothing re-encrypts in place yet.
Connecting without a key is refused with `INTEGRATION_KEY_MISSING` rather than
storing a token in plaintext.

**The same key also protects webhook signing secrets.** `webhook.secret` rides
the same envelope, bound to `(account, webhook)` rather than `(account,
provider)`, and is decrypted only at signing time. The consequences for a
deployment that has no key are deliberately asymmetric:

- Webhooks that **already exist** with a plaintext secret keep delivering,
  signed exactly as before. Nothing about them changes.
- **Creating** a webhook is refused with the same `INTEGRATION_KEY_MISSING`,
  because the only alternative is minting a fresh signing secret and writing it
  to disk in the clear.
- A webhook whose secret is **already encrypted** refuses to deliver rather than
  falling back to an unsigned POST — a key that has gone missing is a
  deployment fault, and an unsigned delivery would strip the very guarantee the
  subscriber authenticates on.

Once a key is present, a legacy plaintext secret is re-encrypted in place the
first time that webhook signs a delivery. The signature the subscriber verifies
is byte-identical before and after, so no subscriber needs to be told.

> **Treat this key as unrecoverable state, not config.** Once a deployment sets
> a valid key, every legacy plaintext secret is drained on its next delivery.
> From that point, **losing or rotating the key means every webhook subscriber
> must be reconfigured with a new secret** — nothing re-encrypts in place yet,
> and there is no command that reads a secret back. This is the same rotation
> caveat the CRM credentials carry, with a worse blast radius: a CRM token can
> be re-pasted from the provider's portal, but a signing secret exists only
> here. Back the key up the way you back up the database.

> **A key outage drops webhook events once the retry horizon passes.** A refused
> delivery is an ordinary outbox failure, so it is retried like any other
> (exponential backoff from 1 s, capped at 15 min) until it has spent its five
> attempts AND been failing for `OUTBOX_RETRY_HORIZON_MS` (default 24 h); then
> the row is marked `failed`, which is terminal, with no re-drive path. Restore
> the key within the horizon and the queued events go out; after it, they do
> not.

A private app needs exactly two scopes, and there is no meetings scope to grant:
`crm.objects.contacts.read` and `crm.objects.contacts.write`. A missing scope
surfaces as a 403 on the first booking, which marks the integration unhealthy
and records the scope names; it is never auto-disconnected, so granting the
scope in the portal is enough to recover. Disconnecting scrubs the credential,
marks queued write-out `skipped`, and deletes nothing in the CRM.

### Search engines and suite links (web)

| Var | Default | Notes | Secret? |
|---|---|---|---|
| `NOINDEX` | unset | Runtime, read per request. `1`, `true` or `yes` marks the whole deployment as not for search: `X-Robots-Tag: noindex, nofollow` on every page and route response (build assets under `/_next` and the icons excepted), `<meta name="robots" content="noindex, nofollow">` on every page, and a `robots.txt` that disallows everything. Use it on staging and preview copies, whose booking pages would otherwise compete with production's. Unset, `robots.txt` leaves the booking pages open and keeps crawlers out of `/admin`, `/login`, `/onboarding` and `/api` | no |
| `NEXT_PUBLIC_FORMS_URL` | unset | **Build-time** for web. Where your Forms sidecar lives. Set, the dashboard's app switcher links to it in a new tab (tagged `utm_source=calendars&utm_medium=app_switcher`); unset, it lists Forms as "Coming soon". The switcher appears only when this or `NEXT_PUBLIC_PLATFORM_URL` is set | no |

### Outbox, CORS, rate limiting

| Var | Default | Notes | Secret? |
|---|---|---|---|
| `OUTBOX_WORKER_ENABLED` | `true` | set `false` if a separate process drains the outbox. Several API replicas may all run it: rows are claimed with a lease, so none is delivered twice at once | no |
| `OUTBOX_POLL_MS` | `5000` | poll interval (a retry due sooner wakes the worker on time) | no |
| `OUTBOX_MAX_ATTEMPTS` | `5` | reserved; every row gets five attempts before the retry horizon may end it | no |
| `OUTBOX_RETRY_HORIZON_MS` | `86400000` | how long a failing delivery keeps being retried, counted from its first failure (backoff 1 s, 2 s, 4 s ... capped at 15 min, jittered). `0` = give up after the five attempts, the old behaviour | no |
| `OUTBOX_CONCURRENCY` | `4` | deliveries in flight per kind of work (emails, calendar writes, webhooks, CRM, sign-up sync) per process. A booking's calendar writes, one side's mail about a booking, and one subscriber's events about a booking each go one at a time in the order queued, so a retry never lets a later one overtake it; a slow webhook subscriber holds at most one slot per process | no |
| `OUTBOX_LEASE_MS` | `300000` | how long a claimed row belongs to the worker that claimed it; a live delivery renews it, a dead replica's rows are taken over when it runs out | no |
| `CORS_ORIGINS` | `PUBLIC_APP_URL` only | comma-separated allowlist to embed the widget on other domains | no |
| `RATE_LIMIT_ENABLED` | `true` | per-IP token bucket on public endpoints | no |
| `RATE_LIMIT_CAPACITY` | `60` | burst | no |
| `RATE_LIMIT_REFILL_PER_SEC` | `1` | sustained refill | no |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS` | `1` | reverse proxies in front of the API that append to `X-Forwarded-For` (1 = one load balancer, 2 = CDN + load balancer, 0 = exposed directly). The limiter keys on the entry this many from the right. Set it on the web app too when `INTERNAL_API_SECRET` is set: the web reads the visitor's address the same way | no |
| `INTERNAL_API_SECRET` | unset | **API and web, same value** (min 32 chars). The booking pages call the API from the web server, so without it every visitor shares the web server's rate-limit bucket and a busy page answers visitors with 429s. With it set on both, the web sends the visitor's address beside the secret and the limiter counts each visitor. The API trusts a forwarded address only beside the matching secret and an IP literal; anything else is keyed as before, and a wrong secret is only counted in the log (one line a minute, no addresses). The web sends it only to the API named by the server-side `API_URL`, so set `API_URL` on the web explicitly to a private or in-cluster address; with `API_URL` unset (the `NEXT_PUBLIC_API_URL` fallback, a public host) the web never sends it and logs a warning at startup. An empty value counts as unset. Set it whenever the web app reaches the API through your reverse proxy or a private network | **yes** |
| `REQUEST_LOG_ENABLED` | `true` | one line per request (method, route template, status, duration, request id, error code, account); JSON when `NODE_ENV=production`. Never logs query strings, bodies, headers or client addresses | no |
| `MCP_ENABLED` | `true` | serve the MCP endpoint `POST /mcp` (see [docs/MCP.md](docs/MCP.md)); `false` answers 404. The dashboard's MCP & API page asks the API for this switch and shows how to connect an agent only while it is on, whatever `MCP_PUBLIC_URL` says | no |
| `MCP_PUBLIC_URL` | unset | the address shown to people connecting an agent. With OAuth off it is display only. With `OAUTH_ENABLED=true` it is **required** and is the resource every access token is issued for (its audience): set it to exactly the URL people paste, path included | no |
| `MCP_ALLOWED_ORIGINS` | unset | comma-separated browser origins allowed to call `/mcp`. A request with any other `Origin` header gets 403; clients that send none (every non-browser MCP client) are unaffected. A browser-hosted client must also be in `CORS_ORIGINS` | no |
| `MCP_ALLOWED_HOSTS` | unset | comma-separated hostnames `/mcp` answers to (DNS-rebinding guard). Unset = no Host check | no |
| `MCP_RATE_LIMIT_CAPACITY` | `30` | tool-call burst per API key (per client address when anonymous). Per process, so N replicas allow up to N times this | no |
| `MCP_RATE_LIMIT_REFILL_PER_SEC` | `1` | sustained refill for the above | no |
| `MCP_WRITE_RATE_LIMIT_CAPACITY` | `10` | tighter burst for `book_meeting`, `create_booking`, `reschedule_booking`, `cancel_booking` | no |
| `MCP_WRITE_RATE_LIMIT_REFILL_PER_SEC` | `0.2` | sustained refill for write tools | no |
| `MCP_TOOL_TIMEOUT_MS` | `20000` | how long one tool call may run before the caller gets a timeout error | no |

**Webhook deliveries** are POSTed with `X-Slate-Event` (the event name),
`X-Slate-Signature` (`sha256=` HMAC of the body with the webhook's secret) and
`X-Slate-Delivery` (the delivery's id). A retry sends the same body, signature
and delivery id, so a subscriber that already processed an attempt the sender
saw time out can recognise the retry and ignore it. Each attempt waits at most
10 s for an answer; a slow subscriber holds up only its own deliveries. When a
delivery is given up, the webhook's delivery log in the dashboard says so.

### OAuth for the MCP endpoint (optional)

Off by default; API keys and the public tools need none of this. On, the API is
its own OAuth 2.1 authorization server for `/mcp`, so Claude, ChatGPT, Cursor
and VS Code connect with a sign-in and a consent screen (see
[docs/MCP.md](docs/MCP.md#oauth-connect-claude-chatgpt-cursor-or-vs-code-with-a-sign-in)).
The API refuses to boot with `OAUTH_ENABLED=true` and any required value missing.

| Var | Default | Notes | Secret? |
|---|---|---|---|
| `OAUTH_ENABLED` | `false` | serve the authorization server under `/oauth` and its metadata under `/.well-known/` | no |
| `OAUTH_ISSUER` | unset | **required when on.** The public origin that serves `/oauth/*` and `/.well-known/oauth-authorization-server` (scheme and host only, `https`). It is the `iss` of every token and authorization response: never change it once apps are connected | no |
| `OAUTH_SIGNING_JWK` | unset | **required when on.** The access-token signing key: one EC P-256 private JWK (ES256) as a JSON string. Every replica uses the same key and verifies tokens offline. Rotating it signs every connected app out of its current access token; refresh tokens keep working, so clients recover on their own | **yes** |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | access-token lifetime (60 to 86400). After a Disconnect, an access token already handed out keeps working at most this long | no |
| `OAUTH_GRANT_TTL_DAYS` | `90` | absolute lifetime of a connection; refreshing never extends it | no |
| `OAUTH_REFRESH_REUSE_GRACE_SECONDS` | `10` | a rotated refresh token presented again within this window rotates again (a client retry after a lost response); later, reuse revokes the whole connection. `0` = strict | no |
| `OAUTH_CIMD_ENABLED` | `true` | accept clients identified by a Client ID Metadata Document (an https `client_id` this server fetches) | no |
| `OAUTH_DCR_ENABLED` | `true` | accept Dynamic Client Registration at `/oauth/register`, restricted to a fixed redirect allowlist | no |
| `OAUTH_DCR_EXTRA_REDIRECT_URIS` | unset | comma-separated exact redirect URIs added to that allowlist | no |

Make the key once and store it in your secret manager:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');console.log(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
```

Routing: the browser and the apps reach these paths on the API, so route them to
the API from whatever host `OAUTH_ISSUER` and `MCP_PUBLIC_URL` name:
`/oauth/*`, `/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource*` and `/mcp`. The web app needs nothing
new: its consent page lives at `/auth/consent` (keep that path on the web) and
uses `PUBLIC_APP_URL`. The person signs in through your normal `AUTH_PROVIDER`;
nothing is registered with any identity vendor. Only owners and admins can
approve a connection.

Storage is one additive table, `oauth_record` (migration `0026_oauth_record.sql`
on Postgres, `0025_oauth_record.sql` on SQLite): a new table, no change to
existing ones. It stays empty while OAuth is off; expired rows are purged in
the background.

#### Or: sign in through an external authorization server

Instead of running its own, the API can be a resource server for an OAuth 2.1
authorization server you already have (see
[docs/MCP.md](docs/MCP.md#oauth-with-an-external-authorization-server)). Set
`OAUTH_ENABLED=true`, `MCP_PUBLIC_URL` and `OAUTH_AUTHORIZATION_SERVER`; the
built-in server's vars above are then not needed, and its routes, consent page
and Connected apps answer 404.

| Var | Default | Notes | Secret? |
|---|---|---|---|
| `OAUTH_AUTHORIZATION_SERVER` | unset | the external server's issuer, an origin (`https`; `http` only on localhost outside production), written exactly as its metadata and tokens write it. Set, the API checks that server's access tokens and runs no authorization server of its own | no |
| `OAUTH_JWKS_URL` | unset | where that server publishes its signing keys; unset, the `jwks_uri` of its `/.well-known/oauth-authorization-server` metadata | no |

What the external server must do:

- Support **RFC 8707 resource indicators**: register `MCP_PUBLIC_URL` with it as
  a resource (an API, an audience), so its access tokens carry it as `aud`.
- Sign access tokens with **RS256 or ES256** and publish them in a **JWKS**.
- Let MCP clients register: Client ID Metadata Documents and/or Dynamic Client
  Registration, as Claude, ChatGPT and Cursor expect. That is configured there,
  not here.

What your login provider must do: record the external server's user id (the
`sub` of its tokens) on the member when the person signs in to the web app, in
`member.idp_subject`. A token whose `sub` no active owner or admin carries gets
403 ("open the web app once, then reconnect"). The bundled `workos` provider does
it from the `workos_user_id` claim of its platform token; with another provider,
add the same call (`recordMemberIdpSubject`) where it resolves the member.

Storage: one additive nullable column, `member.idp_subject`, with a unique index
on (`idp_subject`, `account_id`) (migration `0028_member_idp_subject.sql` on
Postgres, `0027_member_idp_subject.sql` on SQLite). NULL everywhere until a login
records it.

> Secrets must come from your platform's secret manager / environment, **never** a
> committed file. Only `NEXT_PUBLIC_*` values reach the browser bundle; keep every
> other secret server-side.

## Reverse proxy + TLS

Terminate TLS at your proxy and route two hostnames:

- `calendars.example.com` → the **web** app (port `3000`)
- `calendars-api.example.com` → the **API** (port `4000`, health at `/health`)

With OAuth on, also route the OAuth paths to the API (see "OAuth for the MCP
endpoint"), and keep forwarding `X-Forwarded-Proto` so its cookies are Secure.

Behind a proxy, derive the request origin from `X-Forwarded-*` headers (the app
does this) — set `PUBLIC_APP_URL` to the public web URL and build the web image with
`NEXT_PUBLIC_API_URL` set to the public API URL. If you embed the booking widget on
other domains, add them to `CORS_ORIGINS`.

## Auth options

- **`local` (default)** — an unauthenticated dev stub. Fine for evaluation; the API
  **refuses to boot** with it under `NODE_ENV=production`.
- **`workos` (generic JWT)** — despite the name, this is a provider-agnostic **HS256
  JWT** verifier. Any identity service that mints a JWT with the claims `sub`,
  `account_id`, `email`, `name`, signed with a shared secret, works: set
  `AUTH_PROVIDER=workos` and `JWT_SECRET` to that shared secret. Optionally set
  `JWT_ISSUER` / `JWT_AUDIENCE` to have them enforced. The same validation runs in
  local dev and production because the secret is symmetric. Selecting `workos`
  without `JWT_SECRET` fails loud. Mint a test token offline with
  `pnpm --filter @slate/api auth:mint -- --account acct_dev --sub user_dev`.

## Email options

- **`log-only` (default)** — confirmations are written to the API log; booking flows
  run end-to-end with nothing configured.
- **`noop`** — silently drop (useful in tests).
- **`smtp`** — any SMTP server; set `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` and, if
  required, `SMTP_USER`/`SMTP_PASS`.
- **`http`** — POST each message to an HTTP email service. Two wire profiles:
  - `generic` (default) — a provider-agnostic JSON body with an optional Bearer
    token (`EMAIL_HTTP_TOKEN`). Point `EMAIL_HTTP_ENDPOINT` at any send endpoint.
  - `transactional-v1` — a managed contract (mode/category/idempotency key + base64
    attachments) with timestamped-HMAC service auth: set `EMAIL_HTTP_CLIENT_ID` and a
    server-only `EMAIL_HTTP_SIGNING_SECRET` (the secret is never transmitted).

## Connecting an external calendar backend

`CALENDAR_PROVIDER=disabled` (the default) subtracts only local bookings from
availability and writes no events out — perfect for a self-host that doesn't need
external calendar sync. To sync with real calendars, set `CALENDAR_PROVIDER=external`
and supply a **backend** that the generic HTTP adapter talks to. The adapter is
strictly vendor-neutral: it mints a bearer, sends JSON, maps non-2xx to a thrown
error (so the outbox retries), and enforces a timeout — nothing else. All
request/response shaping lives behind a `CalendarWire`.

### The generic REST contract

The committed default (`GenericRestWire`, in
`apps/api/src/calendar.backend.generic.ts`) speaks this clean REST contract — all
JSON, `Authorization: Bearer <token>`. Implement it on your own calendar service and
set `CALENDAR_API_BASE_URL` + a static `CALENDAR_API_TOKEN`:

```
POST   /v1/free-busy                                 → { busy: [{ startUtc, endUtc }] }
POST   /v1/events                                    → { externalEventId, externalCalendarId?, meetingUrl? }
PATCH  /v1/events/:externalEventId                   → { externalEventId, ... }
DELETE /v1/connections/:ref/events/:externalEventId  → 204
GET    /v1/connections/:ref/calendars                → { calendars: [{ id, name, primaryEmail?, isPrimary? }] }
GET    /v1/connections/:ref                          → { ok, detail }
POST   /v1/connect                                   → { connectUrl }
GET    /v1/connect/connections?tenantKey=&provider=  → { connections: [{ connectionRef, provider, primaryEmail?, name?, connected? }] }
```

`connectionRef` is **opaque** end-to-end: the contract only ever echoes it back, so
your backend decides what it means.

#### Free-busy is read two weeks at a time, and each answer must be complete

The public availability read caps itself at **60 days**, and the booking page's
month calendar asks for the full window so a visitor can page between months
without a refetch. So 60 days is the normal read, not an edge case.

That read does not reach your backend as one request. `POST /v1/free-busy` is
called once per connection for each window of **at most 14 days**, at most four calls
in flight at once and at most four started per second for one host, and the answers are
merged. A 60-day read is five calls per connection. A window answered with 429 or a 5xx
is asked again, up to three attempts, waiting your `Retry-After` when you send one; any
other error fails the read.
The create-time conflict check reads only the slot being booked, in one call.

**Each answer must hold every busy interval that overlaps its window.** An error
is safe: this path is *fail-closed*, so if any window errors the availability
read returns zero slots and `emptyReason: CALENDAR_UNAVAILABLE` rather than times
that might already be taken. A short answer is not safe: a backend that returns a
200 with only part of the window (the first page of a paged event listing, for
instance) makes the missing events look like free time, and visitors are offered
slots the create-time check then refuses. If your upstream calendar API pages its
results, follow the pages inside your backend and merge them before answering.

#### Conferencing links

`POST /v1/events` and `PATCH /v1/events/:id` both carry
`requestConferenceLink: boolean` in the request body. When it is `true`, create a
conferencing room for the event and return its join URL as `meetingUrl`; when it
is `false` or absent, create none.

Three rules make a booking end up with exactly one room:

- **One request per booking.** `requestConferenceLink` is set on at most one
  destination — the organizer's. A team booking's co-host events arrive with
  `requestConferenceLink: false` and the organizer's URL already in
  `description`. Do not mint a competing room for them.
- **On a reschedule, `null` is a valid answer.** Return `meetingUrl` only when
  the room actually changed. A `null` never overwrites the URL already stored, so
  a backend that keeps the same room across a move needs to do nothing.
- **A missing link is never fatal.** If you cannot mint one, return the event
  without `meetingUrl`. The booking still stands and the confirmation email still
  goes out — it simply carries no join line (see
  `docs/adr/0007-the-booking-email-never-waits-on-the-calendar.md`).

The link is stored on `booking_reference.meeting_url` and read from there by the
email, the `.ics` and the manage page. Only `https://` URLs are rendered.

### The ESM module contract (advanced)

For a backend that needs its own token authority (short-lived minted tokens per
tenant) or a non-standard request mapping, point `CALENDAR_BACKEND_MODULE` at an
**absolute path** to an ESM module that default-exports a factory. The interface
(see `apps/api/src/calendar.provider.ts` and `calendar.http-provider.ts`):

```ts
// backend.mjs — default-export a factory `(env) => CalendarBackend`
export default function (env) {
  return {
    baseUrl: 'https://your-calendar-service.example',
    tokenSource: {
      // scope: 'tenant' (per-account ops) | 'admin' (connect flow)
      // subject: opaque connectionRef or tenant key
      async mint(scope, subject) { return '<a-bearer-token>'; },
    },
    wire: {
      // implement CalendarWire: listBusy/parseBusy, createEvent/updateEvent/
      // parseEvent, deleteEvent, listCalendars/parseCalendars,
      // checkConnection/parseHealth, startConnect/parseConnectStart,
      // discoverConnections/parseDiscovered
    },
    // optional: a custom connect handshake that resolves the end provider's
    // OAuth URL directly (skips an intermediate hosted screen)
    // async startConnect(provider, tenantKey) { return { token, connectUrl }; },
  };
}
```

The module is loaded via a dynamic import, so it never has to exist in the public
build; keep it in a private, gitignored `deploy/` directory (see `.gitignore`) and
reference it by `CALENDAR_BACKEND_MODULE`.

## Upgrades & rollback

- **Upgrade:** pull the new images (or rebuild), run pending migrations (additive,
  safe to apply before the new pods start), then roll the API and web. Because
  migrations are additive, an older pod keeps serving during a rolling deploy.
- **Rollback:** deploy the previous image tags. Additive migrations mean the old
  code ignores columns it doesn't know about, so no down-migration is required for a
  normal rollback. Keep previous images in your registry.
- **One exception — `booking.location_kind` (`postgres/0013`, `sqlite/0012`).**
  That migration also *mutates data*: it back-fills the legacy conferencing token
  from `booking.location` into `booking.location_kind` and blanks the old text, so
  a booking taken before the upgrade keeps its meeting link. Deploying the previous
  images does not restore that text. Rollback across this migration is
  forward-only; take a snapshot before upgrading if you need a true point-in-time
  revert.
- **Outbox leases (`postgres/0027`, `sqlite/0026`).** Workers from before this
  migration claim outbox rows without a lease, so while old and new API pods run
  side by side they can deliver the same row twice, and an old pod still gives a
  failing row up after five attempts. Keep the overlap short (or set
  `OUTBOX_WORKER_ENABLED=false` on the old pods during the rollout). Rows
  already queued at the upgrade carry no order key and are ordered by their
  booking (by their subscriber, for a webhook), so for those few rows only, a
  retry of one can still be overtaken by a row about the same booking queued
  after the upgrade. Rolling back is safe: the old code ignores the four
  columns.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| API exits at boot with an env error | A required var failed validation — read the printed list; check `DATABASE_URL`, and `JWT_SECRET` if `AUTH_PROVIDER=workos`. |
| "Refusing to boot: AUTH_PROVIDER=local … production" | You set `NODE_ENV=production` with the dev stub — switch to `workos` (with `JWT_SECRET`) or another real provider. |
| Migrations fail on `CREATE EXTENSION btree_gist` | The DB role lacks the privilege — have a superuser run `CREATE EXTENSION IF NOT EXISTS btree_gist;` once, then re-run migrations. |
| Login redirect bounces away from your app | Your identity service must allow your web origin, and `PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` must match the public hostnames. |
| Web calls the wrong API URL | `NEXT_PUBLIC_API_URL` is build-time-inlined — rebuild the web image with the correct value. |
| Booking confirmations never arrive | Default `EMAIL_PROVIDER=log-only` only logs — configure `smtp` or `http`. |
| `CALENDAR_PROVIDER=external` fails loud at boot | No backend configured — set `CALENDAR_API_BASE_URL` + `CALENDAR_API_TOKEN`, or `CALENDAR_BACKEND_MODULE`, or use `disabled`. |
| Browser requests blocked by CORS | Add the embedding origin(s) to `CORS_ORIGINS`. |
| Saving a booking page says "Too large to save" | A host's avatar and cover are stored inline, so that save can reach ~3MB. If the photo is not itself enormous, the refusal is usually your reverse proxy rather than the app — nginx defaults to `client_max_body_size 1m`; raise it to at least `4m` on both the web and API upstreams. |

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — request flows, seams, double-booking safety.
- [`CLAUDE.md`](CLAUDE.md) — local run/test commands and invariants.
- [`.env.example`](.env.example) — every variable with inline notes.
- [`ANALYTICS.md`](ANALYTICS.md): the product analytics events and what is never sent.
