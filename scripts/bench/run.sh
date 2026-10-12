#!/usr/bin/env bash
# Booking page speed bench, end to end, against a local stack only.
#
#   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs bash scripts/bench/run.sh
#
# Seeds a throwaway SQLite database, gives the seeded host a connected calendar
# that points at the fake backend, starts the fake backend, the API and a
# production build of the web app on their own ports, runs
# `booking-page-speed.mjs`, and stops everything it started. Nothing outside
# this machine is called.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_PORT="${BENCH_BACKEND_PORT:-4517}"
API_PORT="${BENCH_API_PORT:-4417}"
WEB_PORT="${BENCH_WEB_PORT:-3417}"
DB="$ROOT/.data/bench.db"
LOGS="$ROOT/.data/bench-logs"
mkdir -p "$ROOT/.data" "$LOGS"

export DATABASE_URL="file:$DB"
rm -f "$DB"
(cd "$ROOT" && pnpm run db:setup >"$LOGS/seed.log" 2>&1)

# The seeded host checks conflicts against one connected calendar.
MEMBER_ID="$(sqlite3 "$DB" "SELECT m.id FROM member m JOIN account a ON a.id = m.account_id WHERE a.code = 'acme' AND m.handle = 'alex-rivera'")"
ACCOUNT_ID="$(sqlite3 "$DB" "SELECT id FROM account WHERE code = 'acme'")"
sqlite3 "$DB" "INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
  VALUES ('bench-conn', '$ACCOUNT_ID', '$MEMBER_ID', 'generic', 'bench-conn-ref', 'host@example.com', 0, 1, $(date +%s)000)"

pids=()
# The package runners spawn children of their own, so the ports are what is
# certain to be ours.
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for port in "$BACKEND_PORT" "$API_PORT" "$WEB_PORT"; do
    lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  done
}
trap cleanup EXIT

BENCH_BACKEND_PORT="$BACKEND_PORT" node "$ROOT/scripts/bench/fake-calendar-backend.mjs" >"$LOGS/backend.log" 2>&1 &
pids+=($!)

(cd "$ROOT/apps/api" && \
  API_PORT="$API_PORT" PUBLIC_APP_URL="http://localhost:$WEB_PORT" \
  CALENDAR_PROVIDER=external CALENDAR_API_BASE_URL="http://localhost:$BACKEND_PORT" CALENDAR_API_TOKEN=bench \
  RATE_LIMIT_ENABLED=false \
  pnpm exec tsx src/main.ts >"$LOGS/api.log" 2>&1) &
pids+=($!)

(cd "$ROOT/apps/web" && API_URL="http://localhost:$API_PORT" pnpm exec next build >"$LOGS/web-build.log" 2>&1)
(cd "$ROOT/apps/web" && API_URL="http://localhost:$API_PORT" pnpm exec next start -p "$WEB_PORT" >"$LOGS/web.log" 2>&1) &
pids+=($!)

for url in "http://localhost:$API_PORT/health" "http://localhost:$WEB_PORT/"; do
  for _ in $(seq 1 60); do curl -s -o /dev/null "$url" && break; sleep 1; done
done

BENCH_URL="http://localhost:$WEB_PORT/acme/alex-rivera/intro-call" \
BENCH_BACKEND="http://localhost:$BACKEND_PORT" \
  node "$ROOT/scripts/bench/booking-page-speed.mjs"
