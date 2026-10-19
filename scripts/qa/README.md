# QA scripts

Tools for proving a deployment works, beyond the unit suites. Nothing here
names a host, a page or a vendor: every script takes them as arguments. Plain
Node 20, no dependencies.

| Script | What it proves | Where it runs |
|---|---|---|
| `stand-in-calendar.mjs` | A deterministic external calendar backend (the vendor-neutral contract in `apps/api/src/calendar.backend.generic.ts`) that records every write, and can be made to fail, answer malformed, or answer slowly (`QA_CALENDAR_LATENCY_MS`, `/__qa/latency`). The browser suite uses it. | Local |
| `stand-in-analytics.mjs` | A product-analytics ingestion host that serves the real vendor library (the web app's pinned `posthog-js` devDependency), decodes its batches and records every browser and server event, so the browser suite runs with analytics on and asserts exactly what would leave. No third party is reached. | Local |
| `load-availability.mjs` | Availability latency and error rate under 1, 5, 10, 20 concurrent visitors; the 429 share of the public limiter. Stops at the first 5xx. | A development deployment, by hand |
| `hold-race.mjs` | N visitors racing for one time get exactly one hold; with `--busy`, no time the host's calendar has busy is offered or holdable. Gives back every hold it wins, also on Ctrl-C or SIGTERM; never books. | A development deployment, by hand |
| `rate-limit-probe.mjs` | The public limiter answers 429 with `Retry-After`, and a spoofed `X-Forwarded-For` does not buy a fresh bucket. Reads the public profile only. | A development deployment, by hand |
| `webhook-check.mjs` | A subscriber that answers after 15 s times out, one that redirects is refused and its target never fetched, and the outbox retries both and then gives up. Creates ONE booking and two webhooks, and cancels and deletes them at the end. | A local API only: it refuses an `--api` that is not loopback, with no override |

## Where the scripts may point

`load-availability.mjs`, `hold-race.mjs` and `rate-limit-probe.mjs` refuse an
`--api` whose host is not literally loopback (`localhost`, `127.x`, `::1`)
unless `--i-know-this-is-not-prod` is passed, and always refuse a host on
`--deny-hosts <host,...>` (or a subdomain of one). No DNS answer counts as
loopback: `fetch` resolves the name again, so a rebinding host could pass a
lookup and then reach a remote API. Keep your production hosts in that list, in your own shell, not in this
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

## Load, locally

The same load script against a local API, with the stand-in calendar answering
in 300 ms as a real backend would. The limiter is off so the numbers are the
calendar path alone:

```bash
QA_CALENDAR_LATENCY_MS=300 node scripts/qa/stand-in-calendar.mjs 4619 &
DATABASE_URL="file:$PWD/.data/load.db" pnpm db:setup
(cd apps/api && DATABASE_URL="file:$PWD/../../.data/load.db" pnpm exec tsx src/cli/e2e-seed.ts)
(cd apps/api && DATABASE_URL="file:$PWD/../../.data/load.db" API_PORT=4111 CALENDAR_PROVIDER=external \
  CALENDAR_API_BASE_URL=http://127.0.0.1:4619 CALENDAR_API_TOKEN=x RATE_LIMIT_ENABLED=false \
  pnpm exec tsx src/main.ts &)
node scripts/qa/load-availability.mjs --api http://localhost:4111 --page acme/alex-rivera/intro-call \
  --levels 1,5,10,20 --reads 30 --pause 5
```

## Webhooks, local

```bash
INTEGRATION_ENCRYPTION_KEY=$(openssl rand -base64 32) API_PORT=4413 pnpm --filter @slate/api exec tsx src/main.ts
<any https tunnel> to http://127.0.0.1:4520        # prints https://<tunnel>
node scripts/qa/webhook-check.mjs --api http://localhost:4413 --public https://<tunnel> \
  --host-email alex@example.com --page acme/alex-rivera/intro-call
```

Subscribers must be https and public (the API refuses loopback and private
addresses), hence the tunnel.
