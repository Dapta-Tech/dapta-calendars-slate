import { describe, it, expect, beforeEach } from 'vitest';
import type {
  BusyInterval,
  CalendarProvider,
  CalendarSummary,
  ConnectionHealth,
  CreatedEvent,
  ListBusyInput,
} from '@slate/calendar';
import { DisabledCalendarProvider } from '@slate/calendar';
import { createDb, migrate, type Db } from '@slate/db';
import { loadServerEnv } from '@slate/config/env';
import { BusyCache, BusyUnknownError, CachedBusyProvider, connectionTag } from './busy-cache';
import { CalendarEffects } from './calendar-effects';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Tuesday at 00:00 UTC, so "the day" is unambiguous. */
const T0 = Date.UTC(2026, 10, 3);

/** One calendar backend: a busy list per connection, and per-connection faults. */
class FakeCalendar implements CalendarProvider {
  readonly enabled = true;
  calls: ListBusyInput[] = [];
  busy = new Map<string, BusyInterval[]>();
  failing = new Set<string>();
  /** While set, every read waits on it. */
  hold: Promise<void> | null = null;

  async listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    this.calls.push(input);
    if (this.hold) await this.hold;
    const out: BusyInterval[] = [];
    for (const ref of input.connectionRefs) {
      if (this.failing.has(ref)) throw new Error(`backend refused ${ref}`);
      for (const b of this.busy.get(ref) ?? []) {
        if (b.endUtc > input.fromUtc && b.startUtc < input.toUtc) out.push(b);
      }
    }
    return out;
  }
  createEvent(): Promise<CreatedEvent> {
    return Promise.resolve({ externalEventId: 'e1' });
  }
  updateEvent(): Promise<CreatedEvent> {
    return Promise.resolve({ externalEventId: 'e1' });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

const meeting = (startMs: number, minutes = 60): BusyInterval => ({
  startUtc: new Date(startMs).toISOString(),
  endUtc: new Date(startMs + minutes * 60_000).toISOString(),
});

describe('BusyCache: the display cache of busy reads (F2, ADR 0009)', () => {
  let now: number;
  let cal: FakeCalendar;
  let logs: string[];
  let cache: BusyCache;
  let provider: CachedBusyProvider;

  const make = (opts: Partial<ConstructorParameters<typeof BusyCache>[0]> = {}) => {
    cache = new BusyCache({
      ttlMs: 30_000,
      maxStaleMs: 5 * 60_000,
      maxEntries: 100,
      readTimeoutMs: 50,
      failureCooldownMs: 5_000,
      now: () => now,
      warn: (line) => logs.push(line),
      ...opts,
    });
    provider = new CachedBusyProvider(cal, cache);
  };
  // What a visitor's month read looks like: from "now" (to the millisecond) to
  // the end of the month, as the booking page asks it.
  const month = (fromMs: number) => ({
    connectionRefs: ['conn-a'],
    fromUtc: new Date(fromMs).toISOString(),
    toUtc: new Date(T0 + 27 * DAY).toISOString(),
  });

  beforeEach(() => {
    now = T0 + 9 * HOUR;
    cal = new FakeCalendar();
    cal.busy.set('conn-a', [meeting(T0 + 13 * HOUR), meeting(T0 + DAY + 15 * HOUR)]);
    cal.busy.set('conn-b', [meeting(T0 + 10 * HOUR)]);
    logs = [];
    make();
  });

  it('answers from memory inside the TTL, and asks the calendar again after it', async () => {
    const first = await provider.listBusy(month(now));
    expect(first).toHaveLength(2);
    now += 29_000;
    expect(await provider.listBusy(month(now))).toEqual(first);
    expect(cal.calls).toHaveLength(1);
    now += 2_000;
    await provider.listBusy(month(now));
    expect(cal.calls).toHaveLength(2);
  });

  it('visitors whose windows differ by milliseconds share one read (whole UTC days)', async () => {
    await provider.listBusy(month(now));
    await provider.listBusy(month(now + 1));
    await provider.listBusy(month(now + 61_234));
    expect(cal.calls).toHaveLength(1);
    expect(cal.calls[0]!.fromUtc).toBe(new Date(T0).toISOString());
    // The answer is still only what touches the window asked for.
    const late = await provider.listBusy(month(T0 + 14 * HOUR));
    expect(late).toEqual([meeting(T0 + DAY + 15 * HOUR)]);
  });

  it('single flight: twenty concurrent identical reads make one call to the calendar', async () => {
    let release!: () => void;
    cal.hold = new Promise((r) => (release = r));
    make({ readTimeoutMs: 5_000 });
    const reads = Array.from({ length: 20 }, (_, i) => provider.listBusy(month(now + i)));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const answers = await Promise.all(reads);
    expect(cal.calls).toHaveLength(1);
    for (const a of answers) expect(a).toHaveLength(2);
  });

  it('a failed fresh read is answered by the last good read while it is young enough', async () => {
    await provider.listBusy(month(now));
    now += 60_000; // past the TTL, well inside the stale bound
    cal.failing.add('conn-a');
    expect(await provider.listBusy(month(now))).toHaveLength(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/event=stale_served conn=[0-9a-f]{10} age_ms=60000 reason=error/);
  });

  it('beyond the stale bound, or never read, the busy is unknown and the read throws', async () => {
    // Never read.
    cal.failing.add('conn-a');
    await expect(provider.listBusy(month(now))).rejects.toBeInstanceOf(BusyUnknownError);
    expect(logs.at(-1)).toMatch(/event=read_failed .*busy=unknown/);
    // Read once, then the calendar fails for longer than the bound.
    cal.failing.clear();
    now += 10_000; // past the cooldown of the failure above
    await provider.listBusy(month(now));
    now += 5 * 60_000 + 1;
    cal.failing.add('conn-a');
    await expect(provider.listBusy(month(now))).rejects.toBeInstanceOf(BusyUnknownError);
  });

  it('a slow calendar: the last good read answers at the timeout, and the slow read fills the cache', async () => {
    await provider.listBusy(month(now));
    now += 40_000;
    let release!: () => void;
    cal.hold = new Promise((r) => (release = r));
    cal.busy.set('conn-a', [meeting(T0 + 16 * HOUR)]);
    const started = Date.now();
    const answer = await provider.listBusy(month(now));
    // The 50 ms timeout, give or take a timer's slack on a busy runner.
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(answer).toHaveLength(2); // the stale one
    expect(logs.at(-1)).toMatch(/event=stale_served .*reason=timeout/);
    cal.hold = null;
    release();
    await new Promise((r) => setTimeout(r, 10));
    // The read that was too slow for that visitor landed and is fresh now.
    const calls = cal.calls.length;
    expect(await provider.listBusy(month(now))).toEqual([meeting(T0 + 16 * HOUR)]);
    expect(cal.calls).toHaveLength(calls);
  });

  it('a slow calendar with nothing to stand in: unknown at the timeout, not a hung page', async () => {
    cal.hold = new Promise(() => undefined);
    const started = Date.now();
    await expect(provider.listBusy(month(now))).rejects.toBeInstanceOf(BusyUnknownError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs.at(-1)).toMatch(/reason=timeout .*busy=unknown/);
  });

  it('right after a failure the calendar is not asked again (cooldown); after it, it is', async () => {
    await provider.listBusy(month(now));
    now += 31_000;
    cal.failing.add('conn-a');
    await provider.listBusy(month(now)); // fails, stale served
    const calls = cal.calls.length;
    now += 1_000;
    expect(await provider.listBusy(month(now))).toHaveLength(2);
    expect(cal.calls).toHaveLength(calls);
    now += 5_000;
    cal.failing.clear();
    await provider.listBusy(month(now));
    expect(cal.calls).toHaveLength(calls + 1);
  });

  it('invalidate: the next read asks the calendar, and the old read still stands in on failure', async () => {
    await provider.listBusy(month(now));
    cache.invalidate(['conn-a']);
    cal.busy.set('conn-a', [meeting(T0 + 11 * HOUR)]);
    expect(await provider.listBusy(month(now))).toEqual([meeting(T0 + 11 * HOUR)]);
    expect(cal.calls).toHaveLength(2);
    cache.invalidate(['conn-a']);
    cal.failing.add('conn-a');
    expect(await provider.listBusy(month(now))).toEqual([meeting(T0 + 11 * HOUR)]);
  });

  it('a read already in flight when the cache is invalidated is not kept as fresh', async () => {
    let release!: () => void;
    cal.hold = new Promise((r) => (release = r));
    make({ readTimeoutMs: 5_000 });
    const pending = provider.listBusy(month(now));
    await new Promise((r) => setTimeout(r, 5));
    cache.invalidate(['conn-a']); // a booking was written meanwhile
    cal.hold = null;
    release();
    await pending;
    await provider.listBusy(month(now));
    expect(cal.calls).toHaveLength(2);
  });

  it('holds at most maxEntries windows, least recently used out first', async () => {
    make({ maxEntries: 2 });
    for (const ref of ['conn-a', 'conn-b', 'conn-c']) {
      await provider.listBusy({ ...month(now), connectionRefs: [ref] });
    }
    expect(cache.size).toBe(2);
    expect(cal.calls).toHaveLength(3);
    await provider.listBusy({ ...month(now), connectionRefs: ['conn-c'] });
    expect(cal.calls).toHaveLength(3); // still held
    await provider.listBusy({ ...month(now), connectionRefs: ['conn-a'] });
    expect(cal.calls).toHaveLength(4); // evicted, read again
  });

  it('two calendars on one host: each cached and failing on its own', async () => {
    const both = { ...month(now), connectionRefs: ['conn-a', 'conn-b'] };
    expect(await provider.listBusy(both)).toHaveLength(3);
    now += 60_000;
    // conn-b fails; its last good read stands in, conn-a is read fresh.
    cal.failing.add('conn-b');
    cal.busy.set('conn-a', []);
    expect(await provider.listBusy(both)).toEqual([meeting(T0 + 10 * HOUR)]);
    // conn-b fails past its bound: the HOST's busy is unknown (one calendar
    // could not be read), while conn-a's fresh read is kept for next time.
    now += 5 * 60_000;
    await expect(provider.listBusy(both)).rejects.toMatchObject({ unknown: 1, connections: 2 });
    const calls = cal.calls.length;
    expect(await provider.listBusy({ ...month(now), connectionRefs: ['conn-a'] })).toEqual([]);
    expect(cal.calls).toHaveLength(calls);
  });

  it('logs are rate-limited, and name a connection by a short hash, never its ref', async () => {
    await provider.listBusy(month(now));
    cal.failing.add('conn-a');
    now += 25_000;
    for (let i = 0; i < 5; i++) {
      now += 6_000; // past the TTL and the cooldown, so each read really fails
      await provider.listBusy(month(now));
    }
    expect(cal.calls).toHaveLength(6);
    expect(logs).toHaveLength(1);
    expect(logs.join('\n')).not.toContain('conn-a');
    expect(logs[0]).toContain(`conn=${connectionTag('conn-a')}`);
    // A different event for the same connection has its own allowance, and
    // the next line says how many were held back.
    now += 5 * 60_000;
    await expect(provider.listBusy(month(now))).rejects.toBeInstanceOf(BusyUnknownError);
    expect(logs.at(-1)).toMatch(/event=read_failed .*suppressed=0/);
    now += 6_000;
    cal.busy.set('conn-a', []);
    cal.failing.clear();
    await provider.listBusy(month(now));
    cal.failing.add('conn-a');
    now += 31_000;
    await provider.listBusy(month(now));
    expect(logs.at(-1)).toMatch(/event=stale_served .*suppressed=4/);
  });

  it('everything that is not a busy read goes straight to the calendar', async () => {
    expect(await provider.createEvent({} as never)).toEqual({ externalEventId: 'e1' });
    expect(provider.enabled).toBe(true);
    expect(await provider.checkConnection('x')).toEqual({ ok: true, detail: 'Connected' });
  });
});

describe('CalendarEffects: fresh for decisions, cached for display', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
  });

  it('with the deployment env, display reads go through the cache and decisions never do', () => {
    const cal = new FakeCalendar();
    const env = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const effects = new CalendarEffects(cal, db, env);
    expect(effects.provider).toBe(cal);
    expect(effects.displayProvider).toBeInstanceOf(CachedBusyProvider);
  });

  it('CALENDAR_BUSY_CACHE_TTL_MS=0 turns the cache off; so does no calendar at all', () => {
    const cal = new FakeCalendar();
    const off = loadServerEnv({ NODE_ENV: 'test', CALENDAR_BUSY_CACHE_TTL_MS: '0' } as NodeJS.ProcessEnv);
    expect(new CalendarEffects(cal, db, off).displayProvider).toBe(cal);
    const disabled = new DisabledCalendarProvider();
    const env = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(new CalendarEffects(disabled, db, env).displayProvider).toBe(disabled);
  });
});
