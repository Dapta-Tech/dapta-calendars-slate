/**
 * Where the browser suite's stack lives, and small helpers every file shares.
 * Everything here is invented: the seeded demo account (`acme`), its hosts, and
 * a stand-in calendar backend on loopback.
 */
import { resolve } from 'node:path';

const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const webPort = port('E2E_WEB_PORT', 3411);
const apiPort = port('E2E_API_PORT', 4411);
const limitedApiPort = port('E2E_LIMITED_API_PORT', 4412);
const calendarPort = port('E2E_CALENDAR_PORT', 4519);

export const E2E = {
  webPort,
  apiPort,
  limitedApiPort,
  calendarPort,
  web: `http://localhost:${webPort}`,
  api: `http://localhost:${apiPort}`,
  limitedApi: `http://localhost:${limitedApiPort}`,
  calendar: `http://127.0.0.1:${calendarPort}`,
  signupUrl: 'https://signup.example.test/start',
  /** Where start-api.mjs tees each API's stdout, for the log assertions. */
  logDir: resolve(__dirname, '.results-logs'),
};

export const HOST = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', email: 'alex@example.com' };

export interface StandInCall {
  method: string;
  path: string;
  op?: 'listBusy' | 'createEvent' | 'updateEvent' | 'deleteEvent' | 'listCalendars' | 'checkConnection';
  body?: Record<string, unknown>;
  at: number;
}

export async function standInCalls(op?: StandInCall['op']): Promise<StandInCall[]> {
  const r = await fetch(`${E2E.calendar}/__qa/calls`);
  const { calls } = (await r.json()) as { calls: StandInCall[] };
  return op ? calls.filter((c) => c.op === op) : calls;
}

/** Wait for the outbox to drain a calendar write (it polls every few seconds). */
export async function waitForCall(
  op: StandInCall['op'],
  pred: (c: StandInCall) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<StandInCall> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = (await standInCalls(op)).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`stand-in calendar never saw ${op}`);
}

export async function setCalendarMode(busy: 'ok' | 'error' | 'malformed'): Promise<void> {
  await fetch(`${E2E.calendar}/__qa/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ busy }),
  });
}

/** The same busy calendar the stand-in serves: weekdays, 13:00 and 15:30 UTC, one hour. */
export function standInBusy(startMs: number, endMs: number): boolean {
  const DAY = 86_400_000;
  for (let day = Math.floor(startMs / DAY) * DAY; day < endMs; day += DAY) {
    const dow = new Date(day).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const m of [13 * 60, 15 * 60 + 30]) {
      const s = day + m * 60_000;
      if (s < endMs && s + 3_600_000 > startMs) return true;
    }
  }
  return false;
}

/** Parse an iCalendar body into its VEVENT properties (unfolded). */
export function parseIcs(text: string): Record<string, string> {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const ev = unfolded.split(/BEGIN:VEVENT\r?\n/)[1]?.split(/END:VEVENT/)[0] ?? '';
  const out: Record<string, string> = {};
  for (const line of ev.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).split(';')[0]!;
    out[key] = line.slice(i + 1);
  }
  return out;
}

/** An address this run alone uses, so bookings never trip the duplicate guard. */
export const visitorEmail = (tag: string) => `visitor-${tag}-${Date.now().toString(36)}@example.test`;
