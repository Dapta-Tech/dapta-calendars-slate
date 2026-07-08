# Slate

**Open-source scheduling by Dapta.** Slate is a booking platform — availability,
timezones, and double-booking-safe reservations. **Postgres is the source of
truth** (CI and production run Postgres); **SQLite is a zero-infra dev
accelerator** so you can clone-and-run in 30 seconds. Deploys anywhere (any
Node/Docker host or Vercel).

> Slate is the friendly name for the **Calendars** product. This repository is
> the open-source monorepo that merges the booking backend and the web frontend.

## 60-second quickstart

```bash
git clone <this-repo> slate && cd slate
pnpm install          # Node >= 20, pnpm >= 10
pnpm dev              # builds packages, creates + seeds a SQLite DB, starts both apps
```

Then open:

- **Web** → http://localhost:3000 — a seeded demo booking page at
  [`/acme/alex-rivera/intro-call`](http://localhost:3000/acme/alex-rivera/intro-call)
- **API** → http://localhost:4000/health

No Docker, no Postgres, no VPN, no accounts. The database is a file at
`.data/dev.db`; email is `log-only` (confirmations print to the API log). Reset
the demo data anytime with `pnpm db:reset`.

### Two dev modes

| Mode | Command | Database | Use it for |
|---|---|---|---|
| **Fast** | `pnpm dev` | SQLite file (`.data/dev.db`) | 30-second onboarding, zero infra |
| **Parity** | `pnpm dev:pg` | Postgres (Docker) | Full parity with CI + production |

`pnpm dev:pg` starts a Postgres container (`docker-compose.yml`), migrates,
seeds, and runs both apps against it — the **same engine as CI and production
(Aurora)**, so the GiST double-booking guarantee is exercised locally. Postgres
is the source of truth; SQLite is a portable subset for convenience and **never
limits the schema** — features that need Postgres use Postgres, and the
SQLite-dev path documents where it degrades.

## What you get

- A **public booking page** (`/[accountCode]/[handle]/[slug]`) that server-renders
  real availability slots and books them (double-booking-safe).
- A **pure scheduling engine** (`@slate/engine`) — DST-safe availability→slots,
  round-robin host selection, hashed manage tokens. No DB, no I/O, fully tested.
- **One portable schema** over SQLite (dev) and Postgres (prod) via `DATABASE_URL`
  (`@slate/db`, Drizzle).
- **Hexagonal notifications** (`@slate/notifications`) — an `EmailProvider` port
  with `log-only` / `noop` / `smtp` / generic `http` adapters. A bare fork "sends"
  to the log; wire any provider by config.

## Architecture

```
apps/
  web/    Next.js 16 (App Router, RSC) — booking UI          → @slate/shared, @slate/types
  api/    NestJS — availability + booking API                → @slate/engine, @slate/db, @slate/notifications
packages/
  engine/          pure slot/timezone/host logic (no I/O)
  db/              Drizzle schema + migrations + seed + booking repository
  notifications/   EmailProvider port + adapters
  shared/          timezone/slot/handle utils, i18n, design tokens
  config/          zod env schema + tsconfig/eslint/prettier presets
  types/           zod contracts shared by web + api
```

The web app talks to the API over HTTP — it never imports the database or engine
directly, so the two deploy independently.

### Double-booking safety (dual enforcement)

Two overlapping accepted bookings for the same host are prevented by:

1. an **app-level overlap-check-in-a-transaction** that runs on **both**
   databases, and
2. a Postgres **`EXCLUDE` (btree_gist)** constraint that makes an overlap
   *physically impossible* — the hard guarantee, present in CI and production.

SQLite (fast dev mode) has the app-level guard only; that is the one documented
place the dev subset degrades. **CI runs the Postgres path on every PR** and
directly asserts the `EXCLUDE` constraint rejects an overlap — Postgres is the
tested truth.

## Configuration

Everything has a safe default (see [`.env.example`](.env.example)). Copy it to
`.env` to override. Key vars:

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:./.data/dev.db` | `postgres://…` switches to Postgres |
| `EMAIL_PROVIDER` | `log-only` | `noop` \| `smtp` \| `http` |
| `API_PORT` | `4000` | |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | where the web app reaches the API |

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | build packages, migrate + seed **SQLite**, run web + api |
| `pnpm dev:pg` | same, against **Postgres** in Docker (full parity) |
| `pnpm build` | build everything |
| `pnpm test` | run all unit tests |
| `pnpm typecheck` / `pnpm lint` | type-check / lint the workspace |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | database lifecycle |

## Deploy

Slate is **deployment-agnostic** (Node runtime, no host-only APIs).

- **Vercel** (web): import the repo, set the project root to `apps/web`, set
  `NEXT_PUBLIC_API_URL` to your API URL. Deploy the API separately (below).
- **Docker / any Node host**: `apps/web/Dockerfile` (Next standalone) and
  `apps/api/Dockerfile` (Node runtime). Point `DATABASE_URL` at Postgres.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md). PRs are DCO-signed (`git commit -s`),
Conventional-Commit titled, and green on CI (SQLite + a Postgres parity job).

## License

[MIT](LICENSE) © 2026 Dapta.
