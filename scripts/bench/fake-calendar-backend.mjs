#!/usr/bin/env node
/**
 * A stand-in calendar backend for the booking page speed bench.
 *
 * Speaks the generic REST wire (`apps/api/src/calendar.backend.generic.ts`):
 * `POST /v1/free-busy` answers the busy intervals inside the asked window. The
 * calendar is generated, never read from anywhere: from today for
 * `BENCH_DAYS` days (default 60), `BENCH_PER_DAY` meetings a day (default 14)
 * between 08:00 and 18:00 in the host's zone, with the same seeded spread of
 * lengths the provider spec's `messyCalendar` uses.
 *
 * Every request waits `BENCH_LATENCY_MS` (default 600) before answering, which
 * stands in for the round trip a real backend costs. Requests are counted:
 *   GET  /stats  -> { busyReads, windows: [[fromUtc, toUtc], ...] }
 *   POST /reset  -> clears the counter
 *
 * Usage: BENCH_BACKEND_PORT=4517 node scripts/bench/fake-calendar-backend.mjs
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.BENCH_BACKEND_PORT ?? 4517);
const DAYS = Number(process.env.BENCH_DAYS ?? 60);
const PER_DAY = Number(process.env.BENCH_PER_DAY ?? 14);
const LATENCY_MS = Number(process.env.BENCH_LATENCY_MS ?? 600);
/** The host's UTC offset in hours (the seeded host is on New York time). */
const HOST_OFFSET_H = Number(process.env.BENCH_HOST_OFFSET_H ?? -4);

const MIN = 60_000;
const DAY = 86_400_000;

function generate() {
  let seed = 4242;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const today = new Date();
  // Host midnight today, in UTC.
  const dayZero = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - HOST_OFFSET_H * 3_600_000;
  const out = [];
  for (let d = -1; d <= DAYS + 1; d++) {
    for (let i = 0; i < PER_DAY; i++) {
      const start = dayZero + d * DAY + (8 * 60 + rand(10 * 12) * 5) * MIN;
      const length = [15, 25, 30, 45, 50, 60, 90][rand(7)];
      out.push({ start, end: start + length * MIN });
    }
  }
  return out;
}

const events = generate();
let busyReads = 0;
let windows = [];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/stats') return json(res, 200, { busyReads, windows });
    if (req.method === 'POST' && req.url === '/reset') {
      busyReads = 0;
      windows = [];
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/v1/free-busy') {
      busyReads += 1;
      const body = raw ? JSON.parse(raw) : {};
      const lo = Date.parse(body.fromUtc);
      const hi = Date.parse(body.toUtc);
      windows.push([body.fromUtc, body.toUtc]);
      const busy = events
        .filter((e) => e.start < hi && e.end > lo)
        .map((e) => ({ startUtc: new Date(e.start).toISOString(), endUtc: new Date(e.end).toISOString() }));
      setTimeout(() => json(res, 200, { busy }), LATENCY_MS);
      return;
    }
    json(res, 404, { error: 'NOT_FOUND' });
  });
}).listen(PORT, () => {
  console.log(`fake calendar backend on :${PORT} (${events.length} events, ${LATENCY_MS} ms per read)`);
});
