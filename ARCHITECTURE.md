# Architecture

Dapta Calendars is a Turborepo + pnpm-workspaces monorepo: two deployable apps
over seven packages. This page is the map — the request flows, the dependency
direction, and the ports/adapters seams that keep the project self-hostable. For
how to run and change it, see [`CLAUDE.md`](CLAUDE.md); for self-hosting, see
[`SELF-HOSTING.md`](SELF-HOSTING.md).

## The two request paths

A **public booker** picking a time and an **admin/host** configuring availability
take different routes through the system. The web app never touches the database —
it always goes through the API over HTTP, so the two apps deploy independently.

```
  PUBLIC BOOKER                                  ADMIN / HOST
  ────────────                                   ────────────
  Browser                                        Browser
     │  GET /[accountCode]/[handle]/[slug]          │  /admin/... (dashboard + studio)
     ▼                                              ▼
  apps/web (Next.js, RSC)                        apps/web (Next.js, RSC + islands)
     │  server-renders the event type              │  lib/admin-api.ts
     │  + real availability slots                  │  (Bearer JWT  |  x-slate-email)
     │  uses @slate/engine for slot preview        ▼
     ▼                                           apps/api  (admin/host controllers)
  apps/api  (public controller, /v1/public/*)      │  resolveHost(req) → { accountId, role }
     │  unauthed + rate-limited                     │  permissions.ts role checks
     │  recompute availability server-side (engine) │  every repo call scoped by accountId
     │  book ONE slot in a transaction ────────────▶┌─────────────────────────────────┐
     ▼   (app-level overlap guard + EXCLUDE)        │ packages/db (Drizzle repositories)│
  packages/db  ── insert booking ─────────────────▶│  pg (source of truth) | sqlite    │
     │  enqueue side-effects to the OUTBOX table    └─────────────────────────────────┘
     ▼
  apps/api/outbox.worker.ts  (poll + retry/backoff)
     ├── @slate/notifications → EmailProvider adapter (log-only|noop|smtp|http)
     └── @slate/calendar      → CalendarProvider write-out (disabled|external)
```

Three properties fall out of this shape:

- **The engine is shared and pure**, so the client-side slot preview and the
  server-side authoritative availability always agree. Availability is *always*
  recomputed server-side from stored config + busy intervals — a client can never
  assert its own free slot.
- **The booking write is transactional and double-booking-safe.** The insert runs
  inside a transaction with an app-level overlap check, and Postgres additionally
  enforces a physical `EXCLUDE` constraint (see below).
- **Side-effects are decoupled from the request.** The booking commits, rows are
  written to the `outbox`, and the request returns. A background worker drains the
  outbox with exponential backoff, so a slow or down calendar/email provider never
  fails or blocks a booking.

## Package dependency direction

Dependencies point one way: apps depend on packages; packages depend only on
packages below them; nothing depends on an app. `types` and `engine` are the
shared foundation — a package may depend on them (for example `@slate/db`
reads the reminder contract from `@slate/types`), never the other way round.

```
        apps/web  ────HTTP────▶  apps/api
            │                        │
            ├──────────┬────────┐    ├──────────┬───────────────┬──────────────┐
            ▼          ▼        ▼    ▼          ▼               ▼              ▼
        @slate/engine  @slate/types  @slate/db  @slate/notifications  @slate/calendar
            │              │            │              │                    │
            └──────────────┴────────────┴──────────────┴────────────────────┘
                                        │
                          @slate/shared       @slate/config
                          (i18n, tokens,      (zod env schema,
                           tz/slot/handles)    tsconfig presets)
```

- **`@slate/types`** — the zod contracts both apps validate against: event types,
  bookings, booking fields, and page/studio config (extend additively, never break).
- **`@slate/engine`** — pure, I/O-free scheduling logic: DST-safe availability→slot
  generation, buffers/notice/interval, round-robin & collective host selection,
  hashed manage-token rules, short-link rules. Fully unit-tested; imports only
  `node:crypto`.
- **`@slate/db`** — one portable schema over SQLite (dev) and Postgres (prod) via
  Drizzle, plus migrations, seed, and the account-scoped booking repository.
- **`@slate/notifications`** / **`@slate/calendar`** — two of the side-effect ports
  and their adapters (below).
- **`@slate/shared`** — i18n (`en`/`es`), design tokens, timezone/slot/handle utils,
  growth attribution. **`@slate/config`** — the zod env schema + shared presets.

## The ports/adapters seams

Four boundaries are defined as **ports** (interfaces) with **adapters** wired by
configuration. Public code depends on the port; the concrete adapter is selected at
runtime and **degrades to a safe default when unconfigured** — so a fork with an
empty `.env` runs end-to-end.

| Seam | Port | Adapters | Selector | Bare-fork default |
|---|---|---|---|---|
| **Auth** | `apps/api/src/auth.provider.ts` | `local` stub, `workos` (HS256 JWT) | `AUTH_PROVIDER` | `local` (no identity server) |
| **Calendar** | `packages/calendar` (`CalendarProvider`) | `disabled`, `external` (generic HTTP) | `CALENDAR_PROVIDER` | `disabled` (local busy only, no write-out) |
| **Email** | `packages/notifications/src/email.port.ts` | `log-only`, `noop`, `smtp`, `http` | `EMAIL_PROVIDER` | `log-only` (prints to API log) |
| **Entitlements** | `apps/api/src/entitlements.provider.ts` | `open`, upstream service | `PREMIUM_FEATURES` | `open` (every feature unlocked) |
| **Database** | `createDb(url)` in `packages/db/src/client.ts` | Postgres (`postgres://…`) or SQLite (`file:…`) | `DATABASE_URL` | SQLite at `.data/dev.db` |

Rules that keep the seams intact (enforced by the `calendars-reviewer` agent):

- A concrete adapter's provider-specific symbols never leak past its file —
  controllers, services, and the web app depend on the port only. Selecting a
  provider without its required secret **fails loud**; it never silently falls back
  to an insecure path (`AUTH_PROVIDER=workos` without `JWT_SECRET`;
  `CALENDAR_PROVIDER=external` without a backend).
- **R15 — the calendar seam names no vendor.** `connectionRef` is an opaque string
  end-to-end; the committed `external` adapter speaks a vendor-neutral REST contract
  (`apps/api/src/calendar.backend.generic.ts`). A real integration platform lives in
  a gitignored `deploy/` overlay loaded via `CALENDAR_BACKEND_MODULE` — never in the
  public build.
- **Calendars is always free.** The entitlements seam gates premium perks, not the
  product; `PREMIUM_FEATURES=open` (the OSS default) unlocks everything.

## Double-booking safety (dual enforcement)

Two overlapping accepted bookings for the same host are prevented by:

1. an **app-level overlap-check inside the booking transaction** that runs on
   **both** databases, and
2. a Postgres **`EXCLUDE` (btree_gist)** constraint (`booking_no_overlap`) that
   makes an overlap *physically impossible* — the hard guarantee, present in CI and
   production.

SQLite (fast dev mode) has the app-level guard only; that is the one documented
place the dev subset degrades. **CI runs the Postgres path on every PR**
(`packages/db/src/repository.pg.spec.ts`) and directly asserts the `EXCLUDE`
constraint raises `23P01` on an overlap — Postgres is the tested truth.

## See also

- [`CLAUDE.md`](CLAUDE.md) — run/test commands, invariants, common-task file pointers.
- [`SELF-HOSTING.md`](SELF-HOSTING.md) — production deploy + full env reference.
- [`README.md`](README.md) — quickstart and feature overview.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — DCO, commit conventions, PR gates.
