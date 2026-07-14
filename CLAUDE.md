# Dapta Calendars — guide for Claude Code (and any AI coding agent)

This file is loaded automatically by Claude Code for anyone working in this repo.
It is the operating summary: how to run, test, and change **Dapta Calendars**
without breaking the invariants that keep the project self-hostable and open.
Deeper rationale (request flow, package boundaries, the ports/adapters seams)
lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); contribution mechanics (DCO, PR
gates) live in [`CONTRIBUTING.md`](CONTRIBUTING.md); self-hosting is
[`SELF-HOSTING.md`](SELF-HOSTING.md). Read those when this summary points at them.

> **Naming:** the product is **Dapta Calendars**. Internal packages use the
> `@slate/*` scope — `slate` is the codename, nothing more. Prefer "Dapta
> Calendars" in user-facing text and `@slate/*` only when naming a package.

## What this is

An open-source, self-hostable scheduling & booking platform: availability →
DST-safe slots, single-host and team (round-robin & collective) event types,
external calendar sync, durable notifications with editable templates, and short
shareable links — **double-booking-safe by construction**. A Turborepo + pnpm
-workspaces monorepo of two apps and seven packages. **Postgres is the source of
truth** (CI and production); **SQLite is a zero-infra dev accelerator** so a bare
clone runs in seconds.

## Repo map

```
apps/
  web/   Next.js 16 App Router (RSC) — public booking page + admin dashboard + studio
  api/   NestJS — public availability/booking API, admin/host API, outbox worker
packages/
  types/          zod contracts shared by web + api (event types, bookings, config)
  engine/         pure scheduling logic — availability→slots, round-robin, tokens (NO I/O)
  db/             Drizzle schema (pg + sqlite) + migrations + seed + booking repository
  notifications/  EmailProvider port + adapters (log-only/noop/smtp/http) + booking notifier
  calendar/       CalendarProvider port (disabled default) — external free-busy + write-out
  shared/         i18n (en/es), timezone/slot/handle utils, growth attribution, design tokens
  config/         zod env schema + shared tsconfig/eslint/prettier presets
```

Dependency direction is one-directional: **apps depend on packages, never the
reverse; the web app reaches the API only over HTTP** (it never imports
`@slate/db` or the engine for data at runtime). The engine is pure and shared by
both apps, so the client-side slot preview and the server-side authoritative
verdict always agree.

## How to run (zero-infra SQLite path)

```bash
pnpm install     # Node >= 20, pnpm >= 10
pnpm dev         # builds packages, migrates + seeds a SQLite DB, starts web + api
```

`pnpm dev` runs `db:setup` (`db:migrate` + `db:seed`) **before** launching the
apps, so the schema always exists. Then open:

- **Web** → http://localhost:3000 — seeded demo booking page at
  `/acme/alex-rivera/intro-call`
- **API** → http://localhost:4000/health

No Docker, no Postgres, no accounts. The DB is a file at `.data/dev.db`; email is
`log-only` (booking confirmations print to the API log); dashboard auth is a local
stub (you are logged in as the seeded demo account). Reset demo data with
`pnpm db:reset`.

**Ports.** The web dev port is `3000` (the `apps/web` dev script runs
`next dev -p 3000`); the API listens on `API_PORT` (default `4000`). To relocate
the API, set `API_PORT` and point the web app at it with `NEXT_PUBLIC_API_URL`.
See [`.env.example`](.env.example) for every knob — all have safe defaults.

**Local test instance (a second, isolated copy — no deploys, no port clash).**
The convention for a throwaway instance beside a running `pnpm dev` is web
**:3111** / api **:4111** with its own **absolute** `DATABASE_URL` so the two DBs
never collide:

```bash
(cd apps/api && API_PORT=4111 DATABASE_URL="file:$PWD/../../.data/local-dev.db" pnpm exec tsx src/main.ts &)
(cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:4111 pnpm exec next dev -p 3111 &)
```

**Postgres parity mode** (matches CI + production):

```bash
pnpm dev:pg               # docker compose up postgres, migrate + seed, run both apps
PG_PORT=5433 pnpm dev:pg  # if host port 5432 is already in use
```

The `.claude/skills/local-dev` skill wraps boot / seed / login / reset / parity as
an invokable recipe if you'd rather not remember the commands.

## How to test

Vitest across the board (no Jest). Run from the repo root:

```bash
pnpm test            # all packages + apps (SQLite)
pnpm typecheck
pnpm lint
pnpm build           # builds packages AND both apps (what CI builds)
```

Scope to one workspace, or one file:

```bash
pnpm --filter @slate/engine test
pnpm --filter @slate/db exec vitest run src/repository.spec.ts
```

**Postgres parity test** (the double-booking path CI asserts on every PR):

```bash
docker compose up -d --wait db
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm db:migrate
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm db:seed
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm --filter @slate/db test
```

`packages/db/src/repository.pg.spec.ts` runs against `DATABASE_URL` and directly
asserts the `booking_no_overlap` GiST `EXCLUDE` constraint raises `23P01` on an
overlap — that is the Postgres-is-truth double-booking guarantee. If you touch the
DB layer, run this before you push.

## Architecture invariants (a change MUST respect these)

1. **Dual-dialect schema parity + additive-only migrations.** The data model lives
   in two files — `packages/db/src/schema.pg.ts` (source of truth) and
   `packages/db/src/schema.sqlite.ts` (portable subset). They mirror 1:1 on
   table/column names (Postgres `jsonb`/`bigint` ↔ SQLite `text` JSON / `integer`
   epoch-ms). Any schema change edits **both**, ships a numbered migration in
   **both** `packages/db/migrations/{postgres,sqlite}/`, and is **additive** — new
   nullable columns / new tables, never a destructive rename or drop that would
   break a running deployment.
2. **The engine is pure functions with tests.** `@slate/engine` has no DB, no fs,
   no network (only `node:crypto`). Availability→slot generation (DST-safe),
   round-robin/collective host selection, buffers/notice, and hashed manage tokens
   are deterministic and unit-tested. Keep it that way — never import I/O into
   `packages/engine`.
3. **Double-booking is dual-enforced.** Two overlapping accepted bookings for the
   same host are blocked by (a) an app-level overlap-check-in-a-transaction that
   runs on **both** dialects, **and** (b) a Postgres `EXCLUDE` (btree_gist)
   constraint (`booking_no_overlap`) that makes an overlap physically impossible.
   Never weaken either guard; the booking write stays inside its transaction.
4. **Public/admin API split + account scoping on every admin route.** Public
   endpoints (`apps/api/src/public.controller.ts`, `/v1/public/*`) are unauthed and
   rate-limited. Admin/host controllers resolve a principal via the auth service
   (`this.auth.resolveHost(req)`) and pass `accountId` into every repository call.
   A new admin route MUST resolve the principal and pass its `accountId` — never
   query across accounts. Role checks live in `apps/api/src/permissions.ts`.
5. **Outbox for side-effects.** Calendar write-out and webhook/email deliveries are
   enqueued to a transactional **outbox** and drained by
   `apps/api/src/outbox.worker.ts` with retry + exponential backoff. Never fire a
   calendar write, email, or webhook inline from a request handler — enqueue it
   (see `apps/api/src/calendar-effects.ts`, `email-effects.ts`).
6. **Auth behind a port — never import provider specifics outside it.** The auth
   port is `apps/api/src/auth.provider.ts` (`local` stub + `createAuthProvider`);
   the WorkOS/JWT adapter is `auth.provider.workos.ts`, selected by
   `AUTH_PROVIDER`. No provider-specific import may leak into controllers,
   services, or the web app — they depend on the port only. A bare fork runs on the
   `local` provider; production **refuses** `AUTH_PROVIDER=local` (fail-loud).
7. **Calendar behind a port — vendor-neutral, R15.** The calendar seam is
   `packages/calendar` (`CalendarProvider`) selected by `CALENDAR_PROVIDER`
   (`disabled` default, `external` = the generic-HTTP adapter). **Never name a
   calendar vendor in this repo.** The external adapter speaks a vendor-neutral
   REST contract to `CALENDAR_API_BASE_URL`; a real integration platform is a
   PRIVATE overlay loaded by `CALENDAR_BACKEND_MODULE` (gitignored `deploy/`),
   never committed here.
8. **Entitlements behind a port — Calendars is ALWAYS free.** Premium perks (vanity
   slugs, …) gate through `apps/api/src/entitlements.provider.ts`, selected by
   `PREMIUM_FEATURES` (`open` default unlocks everything — a bare fork gets every
   feature; `locked` validates against the upstream entitlement service). Calendars
   never bills on its own.
9. **i18n EN + ES for every user-facing string.** Copy lives in
   `packages/shared/src/i18n/index.ts` as one typed catalog with `en` and `es`
   objects — the compiler enforces key parity. Never hardcode user-facing strings
   in components; add the key to both locales.
10. **No secrets, ever.** Server-only secrets never reach the browser (only
    `NEXT_PUBLIC_*` is client-exposed). `.env` is gitignored; only `.env.example`
    (placeholders) is committed. `scripts/publish-gate.sh` runs in CI — do not add
    real hosts, tokens, credentialed URLs, or internal-infra names anywhere.

## Review gates a PR must pass

- **DCO sign-off** on every commit: `git commit -s` (adds `Signed-off-by:`). Not a
  CLA. Enforced by `.github/workflows/dco.yml`.
- **Conventional Commit** title (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:` …) — enforced by commitlint.
- **CI green**: lint + typecheck + `pnpm test` on **SQLite**, a **Postgres** parity
  job (the `booking_no_overlap` EXCLUDE / double-booking assertion), a full
  `pnpm build`, and the **publish-gate** secret scan. See `.github/workflows/ci.yml`.
- **Changeset** if you changed a published package's behavior: `pnpm changeset`.
- **OptiBot triage**: the repo runs automated PR review (OptiBot). Address every
  comment before merge — fix it, or reply explaining why it does not apply. Do not
  merge over unresolved review comments.

Before opening a PR, run the read-only **`calendars-reviewer`** agent
(`.claude/agents/calendars-reviewer.md`) — it checks your diff against the
invariants above and the gates so CI does not surprise you.

## Branch flow

Feature branch off `main` → PR **into `main`** (there is no long-lived `develop` in
the public core). CI gates + one approving review gate the merge. `main` is always
releasable; the private deploy overlay ships it (see `SELF-HOSTING.md` for how a
self-hoster releases their own build).

## Common tasks (file pointers)

**Add an event-type option / booking field, end-to-end** (order matters):
1. `packages/types/src/index.ts` — extend the zod contract (additive; keep v1 parsing).
2. `packages/engine/src/*` — if it affects slot generation / host selection, add the
   pure logic + unit tests.
3. `packages/db/src/schema.pg.ts` **and** `schema.sqlite.ts` — add the column
   (nullable) in both; ship a numbered migration in **both** `migrations/{postgres,sqlite}/`.
4. `packages/db/src/repository.ts` — read/write the new field, account-scoped.
5. `apps/api/src/*.controller.ts` / services — expose it, resolving the principal.
6. `apps/web/app/**` — UI; pull copy from the i18n catalog (both `en` + `es`).
7. Tests: engine unit specs + the Postgres parity spec if the DB layer changed.

**Wire an external calendar backend:** implement the vendor-neutral `/v1` REST
contract documented in `apps/api/src/calendar.backend.generic.ts` and set
`CALENDAR_PROVIDER=external` + `CALENDAR_API_BASE_URL` + `CALENDAR_API_TOKEN`; or
point `CALENDAR_BACKEND_MODULE` at a private overlay. See
[`SELF-HOSTING.md`](SELF-HOSTING.md) → "Connecting an external calendar backend".

**Add a language:** `packages/shared/src/i18n/index.ts` — extend the locale union,
add a full message const (the interface forces complete key coverage), wire it into
the message getter.

## Related

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — request flows, package dependency
  direction, the four ports/adapters seams, double-booking safety.
- [`SELF-HOSTING.md`](SELF-HOSTING.md) — production deploy, full env reference,
  external calendar contract, upgrades/rollback, troubleshooting.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — DCO, commit conventions, PR flow.
- [`SECURITY.md`](SECURITY.md) — reporting vulnerabilities (never a public issue).
- [`.claude/agents/calendars-reviewer.md`](.claude/agents/calendars-reviewer.md) /
  [`calendars-contributor.md`](.claude/agents/calendars-contributor.md) — the review
  + coding agents for this repo.
