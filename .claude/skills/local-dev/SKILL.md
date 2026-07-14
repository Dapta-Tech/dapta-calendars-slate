---
name: local-dev
description: Boot, seed, log in, reset, and switch database dialect for Dapta Calendars locally. Use when you need to run the app, get into the admin dashboard as a specific user, reset demo data, or exercise the Postgres parity path.
---

# Local dev — Dapta Calendars

Zero infrastructure: a bare clone runs on SQLite with `log-only` email, a
`disabled` calendar, and a `local` auth stub. No Docker, Postgres, or accounts
required for the fast path.

## Boot (SQLite, fast path)

```bash
pnpm install          # Node >= 20, pnpm >= 10
pnpm dev              # builds packages, migrates + seeds SQLite, runs web + api
```

- Web → http://localhost:3000 · API → http://localhost:4000/health
- Seeded demo booking page → http://localhost:3000/acme/alex-rivera/intro-call
- DB file → `.data/dev.db` · confirmations print to the API log (`log-only`)

`pnpm dev` always runs `db:setup` (`db:migrate` + `db:seed`) before the apps start,
so the schema exists. If you instead start an app directly against a **fresh** DB,
run `pnpm db:migrate` first — otherwise the outbox worker fails on a missing table.

**Relocating ports:** the web dev port is `3000` (`apps/web` runs `next dev -p
3000`); the API listens on `API_PORT` (default `4000`). Point the web app at a
relocated API via `NEXT_PUBLIC_API_URL`.

## Second, isolated instance (local test copy — :3111 / :4111)

To run a throwaway instance beside `pnpm dev` without a port or DB clash, use web
**:3111** / api **:4111** with its own **absolute** `DATABASE_URL`:

```bash
(cd apps/api && API_PORT=4111 DATABASE_URL="file:$PWD/../../.data/local-dev.db" pnpm exec tsx src/main.ts &)
(cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:4111 pnpm exec next dev -p 3111 &)
```

## Log in to the dashboard

With `AUTH_PROVIDER=local` (the default), you are logged in as the seeded demo
account. To act as a specific user:

- Set `DEV_LOGIN_EMAIL=you@example.com` in `.env` — the stub resolves that member,
  JIT-creating a fresh account + member if none exists.
- Or send the header `x-slate-email: you@example.com` on an API request (it
  overrides `DEV_LOGIN_EMAIL`).
- Set `AUTH_LOCAL_STRICT=true` to get a real "logged out" state (a request with no
  identity returns 401 instead of falling back to the seeded account), so you can
  exercise the login/logout redirect flow.

To test the WorkOS-style JWT path offline (no identity server), mint a token the
`workos` provider will accept:

```bash
pnpm --filter @slate/api auth:mint -- --account acct_dev --sub user_dev
# then call the API with:  Authorization: Bearer <token>
```

## Reset demo data

```bash
pnpm db:reset         # drop + recreate + reseed the current database
```

## Postgres parity mode (matches CI + production)

```bash
pnpm dev:pg               # docker compose up postgres, migrate + seed, run both apps
PG_PORT=5433 pnpm dev:pg  # if host port 5432 is already in use
```

Run the double-booking parity test directly against Postgres:

```bash
docker compose up -d --wait db
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm db:migrate
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm db:seed
DATABASE_URL=postgres://slate:slate@localhost:5432/slate pnpm --filter @slate/db test
```

`packages/db/src/repository.pg.spec.ts` books a slot, rejects the double-book, and
asserts the `booking_no_overlap` GiST `EXCLUDE` constraint raises `23P01` on an
overlap — the Postgres-is-truth guarantee.

On Windows, run these `pnpm` scripts from git-bash or WSL — they use POSIX shell
syntax (`${PG_PORT:-5432}`) that `cmd.exe` / PowerShell do not expand.
