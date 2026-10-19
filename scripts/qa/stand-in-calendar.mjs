#!/usr/bin/env node
// A deterministic stand-in for an external calendar backend. It speaks the
// vendor-neutral REST contract in apps/api/src/calendar.backend.generic.ts, so
// the API runs against it with:
//
//   CALENDAR_PROVIDER=external
//   CALENDAR_API_BASE_URL=http://127.0.0.1:<port>
//   CALENDAR_API_TOKEN=<anything>
//
// Busy calendar: every weekday, two one-hour meetings at 13:00 and 15:30 UTC,
// forever. Nothing random, nothing tied to the clock, so a test can compute the
// same busy set without asking.
//
// Every contract call is recorded. Test-only endpoints, all under /__qa:
//   GET  /__qa/calls          the recorded calls, oldest first
//   POST /__qa/reset          forget calls and created events, clear the mode, restore the latency
//   POST /__qa/mode {busy}    'ok' (default) | 'error' (500) | 'malformed' (200, wrong shape)
//   POST /__qa/latency {ms}   wait this long before answering each contract call (default 0)
//
// QA_CALENDAR_LATENCY_MS sets the starting latency, so a load run can stand in
// for a real backend's round trip instead of answering in a millisecond.
//
// Usage: node scripts/qa/stand-in-calendar.mjs [port]   (default 4519, or QA_CALENDAR_PORT)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const MEETINGS_UTC_MIN = [13 * 60, 15 * 60 + 30];
const MEETING_MS = 60 * 60_000;

/** The busy intervals overlapping [fromMs, toMs). Exported shape matches the contract. */
export function busyBetween(fromMs, toMs) {
  const out = [];
  for (let day = Math.floor(fromMs / DAY) * DAY; day < toMs; day += DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const m of MEETINGS_UTC_MIN) {
      const s = day + m * 60_000;
      const e = s + MEETING_MS;
      if (s < toMs && e > fromMs) out.push({ startUtc: new Date(s).toISOString(), endUtc: new Date(e).toISOString() });
    }
  }
  return out;
}

export function startStandIn(port = 0) {
  const calls = [];
  const events = new Map();
  let mode = 'ok';
  const raw = Number(process.env.QA_CALENDAR_LATENCY_MS ?? 0);
  const startLatency = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 120_000) : 0;
  let latencyMs = startLatency;

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, 'http://stand-in');
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };

    if (url.pathname.startsWith('/__qa/')) {
      if (url.pathname === '/__qa/calls') return send(200, { calls });
      if (url.pathname === '/__qa/reset') {
        calls.length = 0;
        events.clear();
        mode = 'ok';
        latencyMs = startLatency;
        return send(200, { ok: true });
      }
      if (url.pathname === '/__qa/latency') {
        const ms = Number(body?.ms ?? 0);
        latencyMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120_000) : 0;
        return send(200, { latencyMs });
      }
      if (url.pathname === '/__qa/mode') {
        mode = body?.busy ?? 'ok';
        return send(200, { mode });
      }
      return send(404, { error: 'NOT_FOUND' });
    }

    const call = { method: req.method, path: url.pathname, body, at: Date.now() };
    calls.push(call);
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

    if (req.method === 'POST' && url.pathname === '/v1/free-busy') {
      call.op = 'listBusy';
      if (mode === 'error') return send(500, { error: 'stand-in failure' });
      if (mode === 'malformed') return send(200, { unexpected: true });
      return send(200, { busy: busyBetween(Date.parse(body.fromUtc), Date.parse(body.toUtc)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/events') {
      call.op = 'createEvent';
      const externalEventId = `evt_${randomUUID()}`;
      const meetingUrl = body.requestConferenceLink ? `https://meet.example.test/${externalEventId}` : null;
      events.set(externalEventId, body);
      return send(200, { externalEventId, externalCalendarId: body.calendarId ?? 'primary', meetingUrl });
    }
    const patch = url.pathname.match(/^\/v1\/events\/([^/]+)$/);
    if (req.method === 'PATCH' && patch) {
      call.op = 'updateEvent';
      const id = decodeURIComponent(patch[1]);
      if (!events.has(id)) return send(404, { error: 'NOT_FOUND' });
      events.set(id, body);
      // Same room across a move: null never overwrites the stored URL.
      return send(200, { externalEventId: id, meetingUrl: null });
    }
    const del = url.pathname.match(/^\/v1\/connections\/([^/]+)\/events\/([^/]+)$/);
    if (req.method === 'DELETE' && del) {
      call.op = 'deleteEvent';
      events.delete(decodeURIComponent(del[2]));
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && /^\/v1\/connections\/[^/]+\/calendars$/.test(url.pathname)) {
      call.op = 'listCalendars';
      return send(200, {
        calendars: [
          {
            id: 'primary',
            name: 'Primary',
            isPrimary: true,
            readOnly: false,
            accessRole: 'owner',
            source: 'primary',
            capabilities: { canRead: true, canReadFreeBusy: true, canCreate: true, canUpdate: true, canDelete: true },
          },
        ],
      });
    }
    if (req.method === 'GET' && /^\/v1\/connections\/[^/]+$/.test(url.pathname)) {
      call.op = 'checkConnection';
      return send(200, { ok: true, detail: 'Connected' });
    }
    return send(404, { error: 'NOT_FOUND' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? process.env.QA_CALENDAR_PORT ?? 4519);
  const { port: bound } = await startStandIn(port);
  console.log(`[stand-in calendar] listening on http://127.0.0.1:${bound}`);
}
