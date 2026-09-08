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
| `PUBLIC_APP_URL` | `http://localhost:3000` | production (used to build manage/booking links) | no |
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

### Calendar (external free-busy + event write-out)

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `CALENDAR_PROVIDER` | `disabled` | set `external` to sync an external calendar | no |
| `CALENDAR_API_BASE_URL` | — | required for the generic REST backend | no |
| `CALENDAR_API_TOKEN` | — | required for the generic REST backend | **yes** |
| `CALENDAR_BACKEND_MODULE` | — | optional; absolute path to a private backend module | no |
| `CALENDAR_HTTP_TIMEOUT_MS` | `30000` | — | no |
| `CALENDAR_CONFERENCING_LABEL` | — | optional; display name for the conferencing your backend mints, shown to hosts. Unset ⇒ generic wording | no |

### Email / notifications

| Var | Default | Required when | Secret? |
|---|---|---|---|
| `EMAIL_PROVIDER` | `log-only` | set `smtp` or `http` to actually send | no |
| `MAIL_FROM_EMAIL` | `bookings@example.com` | production | no |
| `MAIL_FROM_NAME` | `Calendars` | — | no |
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

### Outbox, CORS, rate limiting

| Var | Default | Notes | Secret? |
|---|---|---|---|
| `OUTBOX_WORKER_ENABLED` | `true` | set `false` if a separate process drains the outbox | no |
| `OUTBOX_POLL_MS` | `5000` | poll interval | no |
| `OUTBOX_MAX_ATTEMPTS` | `5` | retry ceiling | no |
| `CORS_ORIGINS` | `PUBLIC_APP_URL` only | comma-separated allowlist to embed the widget on other domains | no |
| `RATE_LIMIT_ENABLED` | `true` | per-IP token bucket on public endpoints | no |
| `RATE_LIMIT_CAPACITY` | `60` | burst | no |
| `RATE_LIMIT_REFILL_PER_SEC` | `1` | sustained refill | no |

> Secrets must come from your platform's secret manager / environment, **never** a
> committed file. Only `NEXT_PUBLIC_*` values reach the browser bundle; keep every
> other secret server-side.

## Reverse proxy + TLS

Terminate TLS at your proxy and route two hostnames:

- `calendars.example.com` → the **web** app (port `3000`)
- `calendars-api.example.com` → the **API** (port `4000`, health at `/health`)

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

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — request flows, seams, double-booking safety.
- [`CLAUDE.md`](CLAUDE.md) — local run/test commands and invariants.
- [`.env.example`](.env.example) — every variable with inline notes.
