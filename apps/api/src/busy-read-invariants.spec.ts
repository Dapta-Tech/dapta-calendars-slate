import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, getAvailability, migrate, reserveSlot, seed, sql, type Db } from '@slate/db';
import { CalendarBodyError, GenericRestWire, StaticTokenSource } from './calendar.backend.generic';
import { ExternalCalendarProvider, failureCause } from './calendar.http-provider';

/**
 * The booking engine's invariants under the real read path: the seeded demo
 * page, a connected calendar on its host, and the generic HTTP adapter talking
 * to a deterministic stand-in backend (a fetch stub that answers each window
 * read from one fixed busy calendar).
 *
 *  1. A slot the page offers is never busy on the calendar.
 *  2. A hold on a busy time is refused (INVALID_SLOT); an unreadable calendar
 *     refuses the hold (CALENDAR_UNAVAILABLE). Neither writes a hold row.
 *  3. A failed window read never yields an empty "free" month: the whole read
 *     withholds its slots with CALENDAR_UNAVAILABLE. That includes a 200 whose
 *     body is not the contract's shape, which the generic wire used to read as
 *     "no busy times".
 */
const DAY = 86_400_000;
const HOST = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' };

interface Busy {
  startUtc: string;
  endUtc: string;
}

/** A busy calendar that does not depend on today: every weekday a meeting at
 *  13:00 and 15:30 UTC, an hour each, across the whole read. */
function busyCalendar(fromMs: number, days: number): Busy[] {
  const out: Busy[] = [];
  const day0 = Math.floor(fromMs / DAY) * DAY;
  for (let d = 0; d < days; d++) {
    for (const minute of [13 * 60, 15 * 60 + 30]) {
      const s = day0 + d * DAY + minute * 60_000;
      out.push({
        startUtc: new Date(s).toISOString(),
        endUtc: new Date(s + 3_600_000).toISOString(),
      });
    }
  }
  return out;
}

type Answer = { status: number; body: unknown };

/** The stand-in backend: answers each free-busy window from `calendar`, unless
 *  `override` claims it. The override sees the window's start, so a failing
 *  window keeps failing on every retry, as a real broken range would. */
function standIn(calendar: Busy[], override?: (fromMs: number) => Answer | undefined) {
  const windows: Array<[string, string]> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      fromUtc: string;
      toUtc: string;
    };
    windows.push([body.fromUtc, body.toUtc]);
    const from = Date.parse(body.fromUtc);
    const to = Date.parse(body.toUtc);
    const forced = override?.(from);
    const answer = forced ?? {
      status: 200,
      body: {
        busy: calendar.filter((b) => Date.parse(b.startUtc) < to && Date.parse(b.endUtc) > from),
      },
    };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: () =>
        Promise.resolve(
          typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
        ),
    } as Response;
  }) as unknown as typeof fetch;
  const provider = new ExternalCalendarProvider({
    baseUrl: 'https://calendar-backend.example.test/',
    tokenSource: new StaticTokenSource('test-token'),
    wire: new GenericRestWire(),
    fetchImpl,
    // No real waiting on retries or pacing.
    clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
    busyRequestsPerSecond: 1000,
  });
  return { provider, windows };
}

const overlaps = (s: number, e: number, b: Busy) =>
  s < Date.parse(b.endUtc) && Date.parse(b.startUtc) < e;

describe('busy-read invariants (generic adapter, stand-in backend)', () => {
  let db: Db;
  let fromMs: number;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const host = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle = ${HOST.handle}`,
    ))!;
    await db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${host.account_id}, ${host.id}, ${'generic'}, ${'test-conn-ref'}, 0, 1, ${Date.now()})`,
    );
    // Tomorrow 00:00 UTC, so the minimum notice never trims the first day.
    fromMs = Math.floor(Date.now() / DAY) * DAY + DAY;
  });

  const read = (provider: ExternalCalendarProvider, days: number) =>
    getAvailability(db, { ...HOST, fromMs, toMs: fromMs + days * DAY }, provider);

  it('never offers a slot that is busy on the calendar, over a 60-day read', async () => {
    const calendar = busyCalendar(fromMs, 60);
    const { provider, windows } = standIn(calendar);
    const a = await read(provider, 60);
    expect(a?.emptyReason).toBeUndefined();
    expect(a!.slots.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(1); // the read really was split into windows
    const len = a!.eventType.lengthMinutes * 60_000;
    const clashes = a!.slots.filter((s) => {
      const start = Date.parse(s.startUtc);
      return calendar.some((b) => overlaps(start, start + len, b));
    });
    expect(clashes).toEqual([]);
  });

  it('adjacent month reads offer exactly what one read across both does', async () => {
    const calendar = busyCalendar(fromMs, 60);
    const whole = await read(standIn(calendar).provider, 60);
    const first = await getAvailability(
      db,
      { ...HOST, fromMs, toMs: fromMs + 30 * DAY },
      standIn(calendar).provider,
    );
    const second = await getAvailability(
      db,
      { ...HOST, fromMs: fromMs + 30 * DAY, toMs: fromMs + 60 * DAY },
      standIn(calendar).provider,
    );
    const joined = [...first!.slots, ...second!.slots].map((s) => s.startUtc);
    expect(joined).toEqual(whole!.slots.map((s) => s.startUtc));
  });

  it.each<[string, Answer]>([
    ['a 500 on every attempt', { status: 500, body: { error: 'boom' } }],
    ['a 403', { status: 403, body: { error: 'forbidden' } }],
    ['a 200 with no busy list', { status: 200, body: {} }],
    ['a 200 whose busy is not a list', { status: 200, body: { busy: 'none' } }],
    [
      'a 200 with an entry missing its end',
      { status: 200, body: { busy: [{ startUtc: '2030-01-01T10:00:00Z' }] } },
    ],
    [
      'a 200 with unreadable times',
      { status: 200, body: { busy: [{ startUtc: 'soon', endUtc: 'later' }] } },
    ],
    ['a 200 that is not JSON', { status: 200, body: '<html>proxy error</html>' }],
  ])('one failed window (%s) withholds the whole month', async (_label, answer) => {
    // Windows are 14 days wide. The one holding day 20 fails on every attempt; the others answer
    // cleanly. An empty or partial month here would offer busy times as free.
    const broken = fromMs + 20 * DAY;
    const { provider } = standIn(busyCalendar(fromMs, 60), (from) =>
      from <= broken && broken < from + 14 * DAY ? answer : undefined,
    );
    const a = await read(provider, 60);
    expect(a?.emptyReason).toBe('CALENDAR_UNAVAILABLE');
    expect(a?.slots).toEqual([]);
  });

  it('a hold on a busy time is INVALID_SLOT and writes nothing', async () => {
    const calendar = busyCalendar(fromMs, 14);
    // Find a time the page offers without the calendar but the calendar blocks.
    const local = await getAvailability(db, {
      ...HOST,
      fromMs,
      toMs: fromMs + 14 * DAY,
    });
    const len = local!.eventType.lengthMinutes * 60_000;
    const busyStart = local!.slots
      .map((s) => Date.parse(s.startUtc))
      .find((s) => calendar.some((b) => overlaps(s, s + len, b)));
    expect(busyStart).toBeDefined();
    const out = await reserveSlot(db, { ...HOST, startMs: busyStart! }, standIn(calendar).provider);
    expect(out).toEqual({ ok: false, reason: 'INVALID_SLOT' });
    const rows = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM slot_reservation`);
    expect(Number(rows?.n)).toBe(0);
  });

  it('a hold while the calendar cannot be read is CALENDAR_UNAVAILABLE and writes nothing', async () => {
    const local = await getAvailability(db, {
      ...HOST,
      fromMs,
      toMs: fromMs + 14 * DAY,
    });
    const start = Date.parse(local!.slots[0]!.startUtc);
    const { provider } = standIn([], () => ({
      status: 200,
      body: { unexpected: true },
    }));
    const out = await reserveSlot(db, { ...HOST, startMs: start }, provider);
    expect(out).toEqual({ ok: false, reason: 'CALENDAR_UNAVAILABLE' });
    const rows = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM slot_reservation`);
    expect(Number(rows?.n)).toBe(0);
  });
});

describe('GenericRestWire.parseBusy fails closed', () => {
  const wire = new GenericRestWire();

  it('a zero-length entry blocks nothing and is no reason to withhold the month', () => {
    expect(wire.parseBusy({ busy: [{ startUtc: '2030-01-01T10:00:00Z', endUtc: '2030-01-01T10:00:00Z' }] })).toHaveLength(1);
  });

  it('reads a clean answer, an empty list included', () => {
    expect(wire.parseBusy({ busy: [] })).toEqual([]);
    expect(
      wire.parseBusy({
        busy: [
          {
            startUtc: '2030-01-01T10:00:00.000Z',
            endUtc: '2030-01-01T11:00:00.000Z',
          },
        ],
      }),
    ).toEqual([
      {
        startUtc: '2030-01-01T10:00:00.000Z',
        endUtc: '2030-01-01T11:00:00.000Z',
      },
    ]);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', [{ startUtc: '2030-01-01T10:00:00Z', endUtc: '2030-01-01T11:00:00Z' }]],
    ['no busy key', { items: [] }],
    ['busy as an object', { busy: {} }],
    ['an entry that is a string', { busy: ['2030-01-01T10:00:00Z'] }],
    ['an entry with numbers for times', { busy: [{ startUtc: 1, endUtc: 2 }] }],
    ['an entry that ends before it starts', { busy: [{ startUtc: '2030-01-01T11:00:00Z', endUtc: '2030-01-01T10:00:00Z' }] }],
  ])('throws on %s, and the cause names no body content', (_label, raw) => {
    let caught: unknown;
    try {
      wire.parseBusy(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CalendarBodyError);
    expect(failureCause(caught)).toBe('cause=CalendarBodyError');
  });
});
