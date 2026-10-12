#!/usr/bin/env node
// Availability under concurrent visitors, measured. For each level, N visitors
// each read the booking page's visible month R times back to back; reports
// p50 / p95 / max latency of the answered reads, the 429 share (the public
// rate limiter, keyed per client address, is part of what is measured), and
// errors. Stops at the first 5xx.
//
//   node scripts/qa/load-availability.mjs --api https://api.example.test \
//     --page <accountCode>/<handle>/<slug> [--levels 1,5,10,20] [--reads 30] \
//     [--window month|<days>] [--pause 70] [--out results.json]
//
// --window month  reads what the month grid shows: from now to the end of the
//                 sixth week of the current month's grid (the default).
// --window 60     reads the next 60 days (the pre-#204 read, for comparison).
// --pause         seconds to wait between levels so the limiter refills.
//
// Run by hand, against a development deployment only: every read reaches the
// host's real calendar through the deployment's calendar backend.
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.api || !args.page) {
  console.error('usage: --api <base url> --page <accountCode>/<handle>/<slug> [--levels 1,5,10,20] [--reads 30]');
  process.exit(2);
}
const [accountCode, handle, slug] = args.page.split('/');
const levels = (args.levels ?? '1,5,10,20').split(',').map(Number);
const reads = Number(args.reads ?? 30);
const pauseS = Number(args.pause ?? 70);
const windowArg = args.window ?? 'month';

function readWindow() {
  const now = new Date(Date.now() + 60_000);
  if (windowArg !== 'month') return { from: now, to: new Date(now.getTime() + Number(windowArg) * 86_400_000) };
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const gridStart = new Date(first.getTime() - first.getUTCDay() * 86_400_000);
  return { from: now, to: new Date(gridStart.getTime() + 42 * 86_400_000) };
}

async function read() {
  const { from, to } = readWindow();
  const qs = new URLSearchParams({ accountCode, handle, slug, from: from.toISOString(), to: to.toISOString() });
  const t = performance.now();
  try {
    const r = await fetch(`${args.api.replace(/\/$/, '')}/v1/availability?${qs}`, {
      headers: { 'user-agent': 'calendars-qa-load/1.0' },
      signal: AbortSignal.timeout(120_000),
    });
    const ms = performance.now() - t;
    const body = r.ok ? await r.json() : await r.text();
    return {
      status: r.status,
      ms,
      slots: r.ok ? body.slots.length : null,
      emptyReason: r.ok ? (body.emptyReason ?? null) : null,
      retryAfter: r.headers.get('retry-after'),
    };
  } catch (err) {
    return { status: 0, ms: performance.now() - t, error: String(err?.name ?? err) };
  }
}

const pct = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const fmt = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(2)}s`);

const report = [];
let stopped = false;
for (const [i, n] of levels.entries()) {
  if (stopped) break;
  if (i > 0) await new Promise((r) => setTimeout(r, pauseS * 1000));
  const rows = [];
  const visitor = async () => {
    for (let k = 0; k < reads && !stopped; k++) {
      const row = await read();
      rows.push(row);
      if (row.status >= 500) stopped = true;
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: n }, visitor));
  const ok = rows.filter((r) => r.status === 200);
  const limited = rows.filter((r) => r.status === 429);
  const failed = rows.filter((r) => r.status !== 200 && r.status !== 429);
  const unavailable = ok.filter((r) => r.emptyReason === 'CALENDAR_UNAVAILABLE');
  const level = {
    visitors: n,
    reads: rows.length,
    seconds: (Date.now() - started) / 1000,
    ok: ok.length,
    rateLimited: limited.length,
    errors: failed.length,
    errorStatuses: [...new Set(failed.map((r) => r.status))],
    calendarUnavailable: unavailable.length,
    slotCounts: [...new Set(ok.map((r) => r.slots))].sort((a, b) => a - b),
    p50: pct(ok.map((r) => r.ms), 50),
    p95: pct(ok.map((r) => r.ms), 95),
    max: ok.length ? Math.max(...ok.map((r) => r.ms)) : null,
    retryAfter: [...new Set(limited.map((r) => r.retryAfter))],
  };
  report.push(level);
  console.log(
    `x${String(n).padEnd(3)} reads ${level.reads}  ok ${level.ok}  429 ${level.rateLimited}  err ${level.errors}` +
      `  p50 ${fmt(level.p50)}  p95 ${fmt(level.p95)}  max ${fmt(level.max)}` +
      `  unavailable ${level.calendarUnavailable}  slots ${JSON.stringify(level.slotCounts)}`,
  );
  if (stopped) console.log('stopped: a 5xx answered (see errors)');
}
if (args.out) writeFileSync(args.out, JSON.stringify({ page: args.page, window: windowArg, levels: report }, null, 2));
