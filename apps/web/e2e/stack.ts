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
const analyticsPort = port('E2E_ANALYTICS_PORT', 4520);

export const E2E = {
  webPort,
  apiPort,
  limitedApiPort,
  calendarPort,
  analyticsPort,
  web: `http://localhost:${webPort}`,
  api: `http://localhost:${apiPort}`,
  limitedApi: `http://localhost:${limitedApiPort}`,
  calendar: `http://127.0.0.1:${calendarPort}`,
  /** The stand-in analytics host (scripts/qa/stand-in-analytics.mjs). */
  analytics: `http://127.0.0.1:${analyticsPort}`,
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

/**
 * Product analytics is ON for the whole suite, pointed at the stand-in, so
 * every flow also proves analytics never gets in its way. The same names reach
 * the web server (playwright.config.ts) and both APIs (start-api.mjs).
 */
export const ANALYTICS_ENV = {
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: 'phc_e2e_stand_in',
  PRODUCT_ANALYTICS_HOST: E2E.analytics,
  // Jordan stands in for the operator's own staff; Alex is a customer.
  PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'jordan@example.com',
};

/** One thing the stand-in analytics host recorded. */
export interface RecordedAnalytics {
  source: 'browser' | 'server';
  /** When the stand-in received it (epoch ms). */
  at: number;
  /** Server events: when the event HAPPENED (ISO), which can be well before it arrives. */
  timestamp?: string;
  type?: 'init' | 'capture' | 'identify' | 'alias' | 'group' | 'reset' | 'dropped';
  instance?: string;
  event?: string;
  distinct_id?: string;
  distinctId?: string;
  properties?: Record<string, unknown>;
  config?: Record<string, unknown>;
  set?: Record<string, unknown> | null;
  groupType?: string;
  groupKey?: string;
  alias?: string;
}

/** Everything the stand-in recorded, optionally only since a moment (epoch ms). */
export async function analyticsRecorded(since = 0): Promise<RecordedAnalytics[]> {
  const r = await fetch(`${E2E.analytics}/__qa/events`);
  return ((await r.json()) as { events: RecordedAnalytics[] }).events.filter((e) => e.at >= since);
}

/** Wait until the stand-in has recorded something that matches. */
export async function waitForAnalytics(
  pred: (e: RecordedAnalytics) => boolean,
  since = 0,
  timeoutMs = 30_000,
): Promise<RecordedAnalytics> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = (await analyticsRecorded(since)).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the stand-in analytics host never recorded the expected call');
}

/** An address this run alone uses, so bookings never trip the duplicate guard. */
export const visitorEmail = (tag: string) => `visitor-${tag}-${Date.now().toString(36)}@example.test`;
