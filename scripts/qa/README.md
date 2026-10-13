# QA scripts

Tools for proving a deployment works, beyond the unit suites. Nothing here
names a host, a page or a vendor: every script takes them as arguments. Plain
Node 20, no dependencies.

| Script | What it proves | Where it runs |
|---|---|---|
| `stand-in-calendar.mjs` | A deterministic external calendar backend (the vendor-neutral contract in `apps/api/src/calendar.backend.generic.ts`) that records every write. The browser suite uses it. | Local |
| `load-availability.mjs` | Availability latency and error rate under 1, 5, 10, 20 concurrent visitors; the 429 share of the public limiter. Stops at the first 5xx. | A development deployment, by hand |
| `hold-race.mjs` | N visitors racing for one time get exactly one hold; with `--busy`, no time the host's calendar has busy is offered or holdable. Gives back every hold it wins, also on Ctrl-C or SIGTERM; never books. | A development deployment, by hand |
| `rate-limit-probe.mjs` | The public limiter answers 429 with `Retry-After`, and a spoofed `X-Forwarded-For` does not buy a fresh bucket. Reads the public profile only. | A development deployment, by hand |
| `webhook-check.mjs` | A subscriber that answers after 15 s times out, one that redirects is refused and its target never fetched, and the outbox retries both and then gives up. Creates ONE booking and two webhooks, and cancels and deletes them at the end. | A local API only: it refuses an `--api` that is not loopback, with no override |

## Where the scripts may point

`load-availability.mjs`, `hold-race.mjs` and `rate-limit-probe.mjs` refuse an
`--api` that does not resolve to loopback unless `--i-know-this-is-not-prod` is
passed, and always refuse a host on `--deny-hosts <host,...>` (or a subdomain of
one). Keep your production hosts in that list, in your own shell, not in this
repository: nothing here names a host. `apps/api/src/qa-scripts.spec.ts` holds
the scripts to it.

## The browser suite

Lives in `apps/web/e2e` (Playwright). It boots the real API (`main.ts`) and web
app on a fresh database with `stand-in-calendar.mjs` as the hosts' calendar:

```bash
pnpm build:packages
pnpm --filter @slate/web exec playwright install chromium   # once
pnpm --filter @slate/web e2e                                # SQLite
E2E_DATABASE_URL=postgres://slate:slate@localhost:5432/slate_e2e pnpm --filter @slate/web e2e
```

## Load, by hand

Against a development deployment only. Every availability read reaches the
host's real calendar through the deployment's backend, so keep to the levels
below and stop at the first 5xx (the scripts do).

```bash
GUARD="--i-know-this-is-not-prod --deny-hosts <your production hosts>"
node scripts/qa/load-availability.mjs --api <api base> --page <code>/<handle>/<slug> $GUARD \
  --levels 1,5,10,20 --reads 30 --out avail.json
node scripts/qa/load-availability.mjs --api <api base> --page <code>/<handle>/<slug> $GUARD \
  --levels 1,5 --reads 5 --window 60          # the 60-day read, for comparison
node scripts/qa/hold-race.mjs --api <api base> --page <code>/<handle>/<slug> $GUARD \
  --visitors 20 --busy busy.json
node scripts/qa/rate-limit-probe.mjs --api <api base> --page <code>/<handle> $GUARD
```

All of them share one client address, and the public limiter keys on it
(`RATE_LIMIT_CAPACITY`, default 60, refilled at `RATE_LIMIT_REFILL_PER_SEC`,
default 1): run them one at a time, and read a level's 429 share as the limiter
at work, not as an outage. `--pause` (default 70 s) lets the bucket refill
between levels.

## Webhooks, local

```bash
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -base64 32) API_PORT=4413 pnpm --filter @slate/api exec tsx src/main.ts
<any https tunnel> to http://127.0.0.1:4520        # prints https://<tunnel>
node scripts/qa/webhook-check.mjs --api http://localhost:4413 --public https://<tunnel> \
  --host-email alex@example.com --page acme/alex-rivera/intro-call
```

Subscribers must be https and public (the API refuses loopback and private
addresses), hence the tunnel.
