#!/usr/bin/env node
// Holds under contention, and holds against the truth.
//
// 1. N visitors race for ONE offered time (POST /v1/reservations at once):
//    exactly one hold may win; every other answer must be a refusal
//    (400 INVALID_SLOT, or 429 RATE_LIMITED once the page's hold cap is full).
// 2. With --busy, holds on times the host's calendar has busy (inside days the
//    page offers) must all be refused. Nothing may be held on a busy time.
//
// Every hold this script wins is given back at the end (POST
// /v1/reservations/release); left alone, a hold expires by itself in ten minutes.
// No booking is ever created.
//
//   node scripts/qa/hold-race.mjs --api https://api.example.test \
//     --page <accountCode>/<handle>/<slug> [--visitors 20] [--days-out 3] \
//     [--busy busy.json] [--probes 5] [--i-know-this-is-not-prod] [--deny-hosts <host,...>]
//
// Refuses a non-loopback --api unless --i-know-this-is-not-prod is passed, and
// always refuses a host on --deny-hosts <host,...> (scripts/qa/target-guard.mjs).
//
// Interrupted (Ctrl-C, SIGTERM), it gives back every hold it won before it
// exits: the page caps live holds, and a dead run must not fill that cap for
// ten minutes.
//
// busy.json: { "busy": [{ "startUtc": "...", "endUtc": "..." }] }, the host's
// busy times exported from their calendar (the same shape the calendar contract
// answers with).
import { readFileSync } from 'node:fs';
import { guardTarget, parseArgs } from './target-guard.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.api || !args.page) {
  console.error('usage: --api <base url> --page <accountCode>/<handle>/<slug> [--visitors 20] [--busy busy.json]');
  process.exit(2);
}
const api = args.api.replace(/\/$/, '');
const [accountCode, handle, slug] = args.page.split('/');
const visitors = Number(args.visitors ?? 20);
const daysOut = Number(args['days-out'] ?? 3);
const probes = Number(args.probes ?? 5);
const headers = { 'content-type': 'application/json', 'user-agent': 'calendars-qa-holds/1.0' };
const won = [];
await guardTarget(args);

async function availability(fromMs, toMs) {
  const qs = new URLSearchParams({
    accountCode,
    handle,
    slug,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
  const r = await fetch(`${api}/v1/availability?${qs}`, { headers });
  if (!r.ok) throw new Error(`availability -> ${r.status}`);
  return r.json();
}

async function hold(startUtc) {
  const r = await fetch(`${api}/v1/reservations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ accountCode, handle, slug, startUtc }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 201 && body.reservationUid) won.push(body.reservationUid);
  return { status: r.status, error: body.error ?? null };
}

async function releaseAll() {
  for (const reservationUid of won.splice(0)) {
    await fetch(`${api}/v1/reservations/release`, { method: 'POST', headers, body: JSON.stringify({ reservationUid }) });
  }
}

// Ctrl-C or a kill mid-race: give every won hold back, then exit.
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(`${signal}: releasing ${won.length} hold(s) before exiting`);
    releaseAll().finally(() => process.exit(130));
  });
}

const tally = (rows) =>
  rows.reduce((acc, r) => {
    const k = `${r.status} ${r.error ?? ''}`.trim();
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

let failed = false;
try {
  // --- 1. the race ---------------------------------------------------------
  const from = Date.now() + daysOut * 86_400_000;
  const a = await availability(from, from + 7 * 86_400_000);
  const target = a.slots[0]?.startUtc;
  if (!target) throw new Error(`no offered time ${daysOut}+ days out (emptyReason=${a.emptyReason ?? 'none'})`);
  const rows = await Promise.all(Array.from({ length: visitors }, () => hold(target)));
  const wins = rows.filter((r) => r.status === 201).length;
  const wrong = rows.filter((r) => r.status !== 201 && !['INVALID_SLOT', 'RATE_LIMITED'].includes(r.error));
  console.log(`[race] ${visitors} visitors on ${target}: ${wins} hold(s) won; answers ${JSON.stringify(tally(rows))}`);
  if (wins !== 1) {
    failed = true;
    console.log(`[race] FAIL: expected exactly one hold, got ${wins}`);
  }
  if (wrong.length) {
    failed = true;
    console.log(`[race] FAIL: unexpected refusals ${JSON.stringify(tally(wrong))}`);
  }
  await releaseAll();

  // --- 2. the truth --------------------------------------------------------
  if (args.busy) {
    const busy = JSON.parse(readFileSync(args.busy, 'utf8')).busy.map((b) => [Date.parse(b.startUtc), Date.parse(b.endUtc)]);
    const window = await availability(Date.now() + 3 * 3_600_000, Date.now() + 21 * 86_400_000);
    const len = window.eventType.lengthMinutes * 60_000;
    const offered = window.slots.map((s) => Date.parse(s.startUtc));
    const clashes = offered.filter((s) => busy.some(([bs, be]) => s < be && bs < s + len));
    console.log(`[truth] ${offered.length} offered times over 21 days; offered but busy: ${clashes.length}`);
    if (clashes.length) {
      failed = true;
      for (const c of clashes.slice(0, 5)) console.log(`[truth] FAIL: offered while busy ${new Date(c).toISOString()}`);
    }
    // Busy starts that land on the page's grid, inside days it offers.
    const days = new Set(offered.map((s) => new Date(s).toISOString().slice(0, 10)));
    const grid = offered.length > 1 ? Math.min(...offered.slice(1).map((s, i) => s - offered[i]).filter((d) => d > 0)) : len;
    const targets = busy
      .map(([bs]) => bs)
      .filter((bs) => bs > Date.now() + 3 * 3_600_000 && days.has(new Date(bs).toISOString().slice(0, 10)))
      .filter((bs) => offered.length === 0 || (bs - offered[0]) % grid === 0)
      .slice(0, probes);
    const answers = [];
    for (const t of targets) answers.push({ t, ...(await hold(new Date(t).toISOString())) });
    const held = answers.filter((x) => x.status === 201);
    console.log(`[truth] holds on ${targets.length} busy times: ${JSON.stringify(tally(answers))}`);
    if (held.length) {
      failed = true;
      for (const h of held) console.log(`[truth] FAIL: a hold on a busy time succeeded ${new Date(h.t).toISOString()}`);
    }
  }
} finally {
  await releaseAll();
}
process.exit(failed ? 1 : 0);
