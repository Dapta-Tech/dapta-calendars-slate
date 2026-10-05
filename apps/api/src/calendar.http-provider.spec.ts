import { describe, it, expect } from 'vitest';
import { GenericRestWire, StaticTokenSource } from './calendar.backend.generic';
import {
  asConnector,
  CalendarHttpError,
  ExternalCalendarProvider,
  splitBusyWindow,
} from './calendar.http-provider';
import { DisabledCalendarProvider } from '@slate/calendar';
import { computeSlots, type Interval } from '@slate/engine';

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** A fetch stub that records calls and replays a queued response per call. */
function stubFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: String(init.method),
      auth: headers['authorization'] ?? null,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[i++] ?? { status: 200, json: {} };
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeProvider(
  responses: Parameters<typeof stubFetch>[0],
  extra: Partial<ConstructorParameters<typeof ExternalCalendarProvider>[0]> = {},
) {
  const { fetchImpl, calls } = stubFetch(responses);
  const provider = new ExternalCalendarProvider({
    baseUrl: 'https://cal.example.test/',
    tokenSource: new StaticTokenSource('tok-123'),
    wire: new GenericRestWire(),
    fetchImpl,
    ...extra,
  });
  return { provider, calls };
}

describe('ExternalCalendarProvider (generic HTTP adapter)', () => {
  it('is enabled and sends an authorized free-busy POST, parsing busy intervals', async () => {
    const { provider, calls } = makeProvider([
      { json: { busy: [{ startUtc: '2026-08-01T14:00:00.000Z', endUtc: '2026-08-01T15:00:00.000Z' }] } },
    ]);
    expect(provider.enabled).toBe(true);
    const busy = await provider.listBusy({
      connectionRefs: ['conn-A'],
      calendarIds: ['calendar-A'],
      fromUtc: '2026-08-01T00:00:00.000Z',
      toUtc: '2026-08-02T00:00:00.000Z',
    });
    expect(busy).toEqual([{ startUtc: '2026-08-01T14:00:00.000Z', endUtc: '2026-08-01T15:00:00.000Z' }]);
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/free-busy');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.auth).toBe('Bearer tok-123');
    expect(calls[0]!.body).toMatchObject({
      connectionRefs: ['conn-A'],
      calendarIds: ['calendar-A'],
    });
  });

  it('short-circuits listBusy with no connection refs (no HTTP call)', async () => {
    const { provider, calls } = makeProvider([]);
    expect(await provider.listBusy({ connectionRefs: [], fromUtc: 'a', toUtc: 'b' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('reads busy per connection ref and merges (one call per ref)', async () => {
    const { provider, calls } = makeProvider([
      { json: { busy: [{ startUtc: '2026-08-01T14:00:00.000Z', endUtc: '2026-08-01T15:00:00.000Z' }] } },
      { json: { busy: [{ startUtc: '2026-08-01T16:00:00.000Z', endUtc: '2026-08-01T17:00:00.000Z' }] } },
    ]);
    const busy = await provider.listBusy({
      connectionRefs: ['conn-A', 'conn-B'],
      fromUtc: '2026-08-01T00:00:00.000Z',
      toUtc: '2026-08-02T00:00:00.000Z',
    });
    expect(busy).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ connectionRefs: ['conn-A'] });
    expect(calls[1]!.body).toMatchObject({ connectionRefs: ['conn-B'] });
  });

  it('creates an event and returns the parsed CreatedEvent', async () => {
    const { provider, calls } = makeProvider([
      { json: { externalEventId: 'ext-9', externalCalendarId: 'conn-A', meetingUrl: 'https://meet/x' } },
    ]);
    const created = await provider.createEvent({
      connectionRef: 'conn-A',
      title: 'Intro',
      startUtc: '2026-08-01T14:00:00.000Z',
      endUtc: '2026-08-01T14:30:00.000Z',
      attendeeEmails: ['sam@example.com'],
    });
    expect(created).toEqual({ externalEventId: 'ext-9', externalCalendarId: 'conn-A', meetingUrl: 'https://meet/x' });
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/events');
  });

  it('moves an event in place via PATCH keeping the same external id', async () => {
    const { provider, calls } = makeProvider([{ json: { externalEventId: 'ext-9' } }]);
    const moved = await provider.updateEvent({
      connectionRef: 'conn-A',
      externalEventId: 'ext-9',
      title: 'Intro',
      startUtc: '2026-08-01T16:00:00.000Z',
      endUtc: '2026-08-01T16:30:00.000Z',
      attendeeEmails: ['sam@example.com'],
    });
    expect(moved.externalEventId).toBe('ext-9');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/events/ext-9');
  });

  it('deletes an event with a URL-encoded ref + id', async () => {
    const { provider, calls } = makeProvider([{ status: 204, text: '' }]);
    await provider.deleteEvent({ connectionRef: 'conn/A', externalEventId: 'ext 9' });
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/connections/conn%2FA/events/ext%209');
  });

  it('lists calendars', async () => {
    const { provider } = makeProvider([
      { json: { calendars: [{ id: 'c1', name: 'Work', isPrimary: true }, { id: 'c2', name: 'Home' }] } },
    ]);
    const cals = await provider.listCalendars('conn-A');
    expect(cals).toHaveLength(2);
    expect(cals[0]).toMatchObject({ id: 'c1', name: 'Work', isPrimary: true });
    expect(cals[0]).toMatchObject({
      readOnly: true,
      capabilities: { canCreate: false, canUpdate: false, canDelete: false },
    });
  });

  it('passes through explicit provider-calendar permissions', async () => {
    const { provider } = makeProvider([
      {
        json: {
          calendars: [
            {
              id: 'writable',
              name: 'Writable',
              readOnly: false,
              accessRole: 'writer',
              source: 'shared',
              capabilities: {
                canRead: true,
                canReadFreeBusy: true,
                canCreate: true,
                canUpdate: true,
                canDelete: false,
              },
            },
          ],
        },
      },
    ]);
    expect(await provider.listCalendars('conn-A')).toEqual([
      expect.objectContaining({
        readOnly: false,
        accessRole: 'writer',
        source: 'shared',
        capabilities: {
          canRead: true,
          canReadFreeBusy: true,
          canCreate: true,
          canUpdate: true,
          canDelete: false,
        },
      }),
    ]);
  });

  it('checkConnection reports health and NEVER throws on backend error', async () => {
    const ok = makeProvider([{ json: { ok: true, detail: 'Connected' } }]);
    expect(await ok.provider.checkConnection('conn-A')).toEqual({ ok: true, detail: 'Connected' });

    const bad = makeProvider([{ status: 401, text: 'expired' }]);
    const health = await bad.provider.checkConnection('conn-A');
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/401/);
  });

  it('throws CalendarHttpError on a non-2xx write so the outbox retries', async () => {
    const { provider } = makeProvider([{ status: 503, text: 'upstream down' }]);
    await expect(
      provider.createEvent({
        connectionRef: 'conn-A',
        title: 't',
        startUtc: '2026-08-01T14:00:00.000Z',
        endUtc: '2026-08-01T14:30:00.000Z',
        attendeeEmails: [],
      }),
    ).rejects.toBeInstanceOf(CalendarHttpError);
  });

  it('startConnect uses the backend override when provided (headless OAuth handshake)', async () => {
    const { provider } = makeProvider([], {
      startConnect: async (provider_, tenantKey) => ({
        token: `tok-${tenantKey}`,
        connectUrl: `https://consent.example.test/oauth?p=${provider_}`,
      }),
    });
    const start = await provider.startConnect('google', 'tenant-1');
    expect(start).toEqual({ token: 'tok-tenant-1', connectUrl: 'https://consent.example.test/oauth?p=google' });
  });

  it('startConnect mints an admin token and returns the connect URL', async () => {
    const { provider, calls } = makeProvider([{ json: { connectUrl: 'https://cal.example.test/oauth?x=1' } }]);
    const start = await provider.startConnect('google', 'tenant-1');
    expect(start).toEqual({ token: 'tok-123', connectUrl: 'https://cal.example.test/oauth?x=1' });
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/connect');
    expect(calls[0]!.body).toMatchObject({ provider: 'google', tenantKey: 'tenant-1' });
  });

  it('discoverConnections lists the tenant connections after a popup', async () => {
    const { provider, calls } = makeProvider([
      { json: { connections: [{ connectionRef: 'conn-A', provider: 'google', primaryEmail: 'me@x.com' }] } },
    ]);
    const found = await provider.discoverConnections('tenant-1', 'google');
    expect(found).toEqual([
      {
        connectionRef: 'conn-A',
        provider: 'google',
        primaryEmail: 'me@x.com',
        // Optional on the wire, so a backend that reports no photo yields null
        // and every surface falls back to its initial tile.
        avatarUrl: null,
        name: null,
      },
    ]);
    expect(calls[0]!.url).toBe('https://cal.example.test/v1/connect/connections?tenantKey=tenant-1&provider=google');
  });

  it('discoverConnections carries the account photo when the backend reports one', async () => {
    const { provider } = makeProvider([
      {
        json: {
          connections: [
            {
              connectionRef: 'conn-A',
              provider: 'google',
              primaryEmail: 'me@x.com',
              avatarUrl: 'https://cdn.example.test/me.jpg',
            },
          ],
        },
      },
    ]);
    const found = await provider.discoverConnections('tenant-1', 'google');
    expect(found[0]!.avatarUrl).toBe('https://cdn.example.test/me.jpg');
  });

  it('discoverConnections ignores a non-string photo rather than passing it on', async () => {
    const { provider } = makeProvider([
      {
        json: {
          connections: [{ connectionRef: 'conn-A', provider: 'google', avatarUrl: { url: 'nope' } }],
        },
      },
    ]);
    const found = await provider.discoverConnections('tenant-1', 'google');
    expect(found[0]!.avatarUrl).toBeNull();
  });

  it('discoverConnections skips not-yet-authorized connection shells (connected:false)', async () => {
    // Opening a hosted connect screen can create a connection shell before the
    // user authorizes; it must not surface as a connected account.
    const { provider } = makeProvider([
      {
        json: {
          connections: [
            { connectionRef: 'conn-shell', provider: 'google', connected: false },
            { connectionRef: 'conn-live', provider: 'google', connected: true },
            { connectionRef: 'conn-legacy', provider: 'google' }, // no flag = assumed live
          ],
        },
      },
    ]);
    const found = await provider.discoverConnections('tenant-1', 'google');
    expect(found.map((c) => c.connectionRef)).toEqual(['conn-live', 'conn-legacy']);
  });

  it('asConnector narrows the external provider but rejects the disabled default', () => {
    const { provider } = makeProvider([]);
    expect(asConnector(provider)).not.toBeNull();
    expect(asConnector(new DisabledCalendarProvider())).toBeNull();
  });
});

/**
 * Windowed busy reads.
 *
 * The defect these pin: a calendar backend that lists events one PAGE at a time
 * answers a long read with the first page only. Nothing fails — the list is
 * simply short — and every event that fell off the page becomes a slot offered
 * as free on a calendar that is busy. The booking page reads its whole window
 * (60 days) in one go; the create-time check reads one slot. So the page
 * offered times the check then refused: "That time was just taken."
 */
describe('ExternalCalendarProvider.listBusy — windowed reads', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FROM = Date.parse('2026-10-05T19:00:00.000Z');
  const at = (ms: number) => new Date(ms).toISOString();

  interface Ev {
    startUtc: string;
    endUtc: string;
  }

  /**
   * A backend holding `events` that answers each read the way a paged listing
   * does when only its first page is read: at most `pageSize` of the events
   * that overlap the asked range, in an order that is NOT chronological.
   */
  function pagedBackend(events: Ev[], pageSize: number, opts: { failOn?: number; instant?: boolean } = {}) {
    const asked: Array<{ fromUtc: string; toUtc: string; ref: string }> = [];
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { fromUtc: string; toUtc: string; connectionRefs: string[] };
      asked.push({ fromUtc: body.fromUtc, toUtc: body.toUtc, ref: body.connectionRefs[0]! });
      const n = asked.length;
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (!opts.instant) await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (opts.failOn === n) {
        return { ok: false, status: 503, text: () => Promise.resolve('unavailable') } as Response;
      }
      const lo = Date.parse(body.fromUtc);
      const hi = Date.parse(body.toUtc);
      const overlapping = events.filter((e) => Date.parse(e.startUtc) < hi && Date.parse(e.endUtc) > lo);
      // Deterministic scramble: a paged listing owes nobody chronological order.
      const scrambled = overlapping
        .map((e, i) => ({ e, k: (i * 7919) % 10007 }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.e);
      const text = JSON.stringify({ busy: scrambled.slice(0, pageSize) });
      return { ok: true, status: 200, text: () => Promise.resolve(text) } as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, asked, peak: () => peak };
  }

  function providerOver(fetchImpl: typeof fetch, busyWindowMs?: number) {
    return new ExternalCalendarProvider({
      baseUrl: 'https://cal.example.test',
      tokenSource: new StaticTokenSource('tok-123'),
      wire: new GenericRestWire(),
      fetchImpl,
      ...(busyWindowMs ? { busyWindowMs } : {}),
    });
  }

  /** `perDay` back-to-back 30-minute meetings from 14:00Z, every day of the range. */
  function fullCalendar(days: number, perDay: number): Ev[] {
    const out: Ev[] = [];
    const dayZero = Date.parse('2026-10-05T00:00:00.000Z');
    for (let d = 0; d < days + 1; d++) {
      for (let i = 0; i < perDay; i++) {
        const start = dayZero + d * DAY + 14 * 60 * 60 * 1000 + i * 30 * 60 * 1000;
        out.push({ startUtc: at(start), endUtc: at(start + 30 * 60 * 1000) });
      }
    }
    return out;
  }
  const key = (e: Ev) => `${e.startUtc}|${e.endUtc}`;
  const inRange = (events: Ev[], lo: number, hi: number) =>
    events.filter((e) => Date.parse(e.startUtc) < hi && Date.parse(e.endUtc) > lo);

  it('splitBusyWindow tiles the range exactly — no gap, no overlap, nothing past the end', () => {
    for (const days of [0.02, 1, 6.9, 7, 7.1, 21, 30, 60]) {
      const to = FROM + days * DAY;
      const w = splitBusyWindow(FROM, to, 7 * DAY);
      expect(w[0]![0]).toBe(FROM);
      expect(w[w.length - 1]![1]).toBe(to);
      for (let i = 0; i < w.length; i++) {
        expect(w[i]![1] - w[i]![0]).toBeGreaterThan(0);
        expect(w[i]![1] - w[i]![0]).toBeLessThanOrEqual(7 * DAY);
        if (i > 0) expect(w[i]![0]).toBe(w[i - 1]![1]);
      }
      expect(w).toHaveLength(Math.ceil(days / 7));
    }
  });

  it('splitBusyWindow passes an empty or inverted range through untouched', () => {
    expect(splitBusyWindow(FROM, FROM, 7 * DAY)).toEqual([[FROM, FROM]]);
    expect(splitBusyWindow(FROM, FROM - DAY, 7 * DAY)).toEqual([[FROM, FROM - DAY]]);
  });

  it('reads the booking page window (60 days) as nine consecutive weeks', async () => {
    const { fetchImpl, asked } = pagedBackend([], 250);
    await providerOver(fetchImpl).listBusy({
      connectionRefs: ['conn-A'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 60 * DAY),
    });
    expect(asked).toHaveLength(9);
    const sorted = [...asked].sort((a, b) => Date.parse(a.fromUtc) - Date.parse(b.fromUtc));
    expect(sorted[0]!.fromUtc).toBe(at(FROM));
    expect(sorted[8]!.toUtc).toBe(at(FROM + 60 * DAY));
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.fromUtc).toBe(sorted[i - 1]!.toUtc);
  });

  it('reads one slot (the create-time check) in exactly one call, as before', async () => {
    const { fetchImpl, asked } = pagedBackend([], 250);
    await providerOver(fetchImpl).listBusy({
      connectionRefs: ['conn-A'],
      fromUtc: '2026-10-06T18:00:00.000Z',
      toUtc: '2026-10-06T18:30:00.000Z',
    });
    expect(asked).toEqual([
      { fromUtc: '2026-10-06T18:00:00.000Z', toUtc: '2026-10-06T18:30:00.000Z', ref: 'conn-A' },
    ]);
  });

  it('REGRESSION: a full calendar read over 60 days comes back complete', async () => {
    // 12 meetings a day for 60 days = 720+ events against a 250-event page.
    const events = fullCalendar(60, 12);
    const expected = inRange(events, FROM, FROM + 60 * DAY);
    expect(expected.length).toBeGreaterThan(700);

    // What shipped: one read for the whole window. The page fills and the rest
    // is dropped without a word. This is the bug, reproduced.
    const single = pagedBackend(events, 250);
    const short = await providerOver(single.fetchImpl, 400 * DAY).listBusy({
      connectionRefs: ['conn-A'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 60 * DAY),
    });
    expect(single.asked).toHaveLength(1);
    expect(short).toHaveLength(250);

    // The fix: the same backend, the same page size, read a week at a time.
    const windowed = pagedBackend(events, 250);
    const busy = await providerOver(windowed.fetchImpl).listBusy({
      connectionRefs: ['conn-A'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 60 * DAY),
    });
    expect(new Set(busy.map(key))).toEqual(new Set(expected.map(key)));
    expect(busy).toHaveLength(expected.length);
  });

  it('a long read and the same days read one at a time give the same busy set', async () => {
    const events = fullCalendar(60, 12);
    for (const span of [1, 5, 7, 14, 21, 30, 45, 60]) {
      const wide = pagedBackend(events, 250);
      const got = await providerOver(wide.fetchImpl).listBusy({
        connectionRefs: ['conn-A'],
        fromUtc: at(FROM),
        toUtc: at(FROM + span * DAY),
      });
      const byDay = new Set<string>();
      for (let d = 0; d < span; d++) {
        const one = pagedBackend(events, 250);
        const day = await providerOver(one.fetchImpl).listBusy({
          connectionRefs: ['conn-A'],
          fromUtc: at(FROM + d * DAY),
          toUtc: at(FROM + (d + 1) * DAY),
        });
        for (const e of day) byDay.add(key(e));
      }
      expect(new Set(got.map(key)), `span ${span}d`).toEqual(byDay);
    }
  });

  it('reports an event that crosses a window boundary once, not twice', async () => {
    const boundary = FROM + 7 * DAY;
    const crossing = { startUtc: at(boundary - 15 * 60 * 1000), endUtc: at(boundary + 15 * 60 * 1000) };
    const endsOnIt = { startUtc: at(boundary - 60 * 60 * 1000), endUtc: at(boundary) };
    const startsOnIt = { startUtc: at(boundary), endUtc: at(boundary + 60 * 60 * 1000) };
    const { fetchImpl } = pagedBackend([crossing, endsOnIt, startsOnIt], 250);
    const busy = await providerOver(fetchImpl).listBusy({
      connectionRefs: ['conn-A'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 14 * DAY),
    });
    expect(busy.map(key).sort()).toEqual([crossing, endsOnIt, startsOnIt].map(key).sort());
  });

  it('reads every connection window by window', async () => {
    const { fetchImpl, asked } = pagedBackend([], 250);
    await providerOver(fetchImpl).listBusy({
      connectionRefs: ['conn-A', 'conn-B'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 21 * DAY),
    });
    expect(asked.filter((a) => a.ref === 'conn-A')).toHaveLength(3);
    expect(asked.filter((a) => a.ref === 'conn-B')).toHaveLength(3);
  });

  it('never has more than six reads in flight', async () => {
    const { fetchImpl, asked, peak } = pagedBackend([], 250);
    await providerOver(fetchImpl).listBusy({
      connectionRefs: ['conn-A', 'conn-B', 'conn-C'],
      fromUtc: at(FROM),
      toUtc: at(FROM + 60 * DAY),
    });
    expect(asked).toHaveLength(27);
    expect(peak()).toBeLessThanOrEqual(6);
    expect(peak()).toBeGreaterThan(1);
  });

  it('fails the whole read when one window fails — never a partial busy list', async () => {
    const events = fullCalendar(60, 4);
    const { fetchImpl, asked } = pagedBackend(events, 250, { failOn: 2 });
    await expect(
      providerOver(fetchImpl).listBusy({
        connectionRefs: ['conn-A', 'conn-B', 'conn-C'],
        fromUtc: at(FROM),
        toUtc: at(FROM + 60 * DAY),
      }),
    ).rejects.toBeInstanceOf(CalendarHttpError);
    // The pool stops asking once a window is lost: far fewer than the 27 reads
    // a healthy backend would have been asked for.
    expect(asked.length).toBeLessThan(27);
  });

  /**
   * The promise the booking page makes: a time it offers can be booked. The
   * page computes its offer from ONE long busy read; the create path re-reads
   * just the chosen slot and refuses on any overlap. If the long read is short
   * of events the two disagree — offered, then refused. Checked here the way a
   * visitor would hit it, for every event length, against a messy calendar.
   */
  describe('what the page offers, the create-time check accepts', () => {
    const MIN = 60_000;
    const WEEKDAYS = [1, 2, 3, 4, 5];

    /** ~14 meetings every weekday, every length, at awkward offsets. */
    function messyCalendar(days: number): Ev[] {
      let seed = 4242;
      const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      const out: Ev[] = [];
      const dayZero = Date.parse('2026-10-05T05:00:00.000Z'); // 00:00 America/Bogota
      for (let d = 0; d <= days; d++) {
        for (let i = 0; i < 14; i++) {
          const start = dayZero + d * DAY + (8 * 60 + rand(10 * 12) * 5) * MIN;
          const length = [15, 25, 30, 45, 50, 60, 90][rand(7)]!;
          out.push({ startUtc: at(start), endUtc: at(start + length * MIN) });
        }
      }
      return out;
    }

    async function offeredThenChecked(events: Ev[], durationMin: number, busyWindowMs?: number) {
      const page = pagedBackend(events, 250, { instant: true });
      const provider = providerOver(page.fetchImpl, busyWindowMs);
      const fromUtc = at(FROM);
      const toUtc = at(FROM + 60 * DAY);
      const busy: Interval[] = (await provider.listBusy({ connectionRefs: ['conn-A'], fromUtc, toUtc })).map(
        (b) => ({ start: new Date(b.startUtc), end: new Date(b.endUtc) }),
      );
      const slots = computeSlots({
        fromUtc: new Date(fromUtc),
        toUtc: new Date(toUtc),
        timeZone: 'America/Bogota',
        availability: [{ days: WEEKDAYS, startTime: '08:00', endTime: '18:00', date: null }],
        durationMin,
        slotIntervalMin: 30,
        busy,
        now: new Date(FROM),
      });
      // The create-time check, exactly as the booking path runs it: read the
      // slot's own span, refuse on any overlap.
      let refused = 0;
      for (const slot of slots) {
        const startMs = slot.getTime();
        const endMs = startMs + durationMin * MIN;
        const conflict = await provider.listBusy({
          connectionRefs: ['conn-A'],
          fromUtc: at(startMs),
          toUtc: at(endMs),
        });
        if (conflict.some((b) => Date.parse(b.startUtc) < endMs && Date.parse(b.endUtc) > startMs)) refused++;
      }
      return { offered: slots.length, refused };
    }

    const events = messyCalendar(60);

    it('the calendar is fuller than one page, so the defect is in play', () => {
      expect(inRange(events, FROM, FROM + 60 * DAY).length).toBeGreaterThan(250 * 2);
    });

    for (const durationMin of [15, 30, 45, 60, 90]) {
      it(`a ${durationMin}-minute event: nothing offered over 60 days is refused at booking`, async () => {
        const { offered, refused } = await offeredThenChecked(events, durationMin);
        expect(offered).toBeGreaterThan(0);
        expect(refused).toBe(0);
      });
    }

    it('and with the whole window in a single read (what shipped), offers ARE refused', async () => {
      const { offered, refused } = await offeredThenChecked(events, 30, 400 * DAY);
      expect(offered).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    });
  });
});
