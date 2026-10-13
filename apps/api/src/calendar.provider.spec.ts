import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadServerEnv } from '@slate/config/env';
import { createCalendarProvider } from './calendar.provider';

describe('createCalendarProvider — env-selected port (E4/E5)', () => {
  it('defaults to the disabled OSS provider (no external calendar)', () => {
    const provider = createCalendarProvider(loadServerEnv({}));
    expect(provider.enabled).toBe(false);
  });

  it('CALENDAR_PROVIDER=disabled is the safe clone-and-run default', () => {
    const provider = createCalendarProvider(loadServerEnv({ CALENDAR_PROVIDER: 'disabled' }));
    expect(provider.enabled).toBe(false);
  });

  it('CALENDAR_PROVIDER=external fails loud without a backend configured', () => {
    expect(() => createCalendarProvider(loadServerEnv({ CALENDAR_PROVIDER: 'external' }))).toThrow(
      /overlay|backend/i,
    );
  });

  it('CALENDAR_PROVIDER=external builds the generic adapter from base URL + static token', () => {
    const provider = createCalendarProvider(
      loadServerEnv({
        CALENDAR_PROVIDER: 'external',
        CALENDAR_API_BASE_URL: 'https://cal.example.test',
        CALENDAR_API_TOKEN: 'tok-xyz',
      }),
    );
    expect(provider.enabled).toBe(true);
  });
});

describe('CALENDAR_BUSY_WINDOW_DAYS: how long one busy request may be', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Reads 62 days for two connections and returns each request's [connection, from, to]. */
  async function sixtyTwoDayRead(extra: Record<string, string>) {
    const sent: Array<[string, string, string]> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { connectionRefs: string[]; fromUtc: string; toUtc: string };
      sent.push([body.connectionRefs.join(','), body.fromUtc, body.toUtc]);
      return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ busy: [] })) } as Response;
    });
    const provider = createCalendarProvider(
      loadServerEnv({
        CALENDAR_PROVIDER: 'external',
        CALENDAR_API_BASE_URL: 'https://cal.example.test',
        CALENDAR_API_TOKEN: 'tok-xyz',
        // Pacing is not under test here; keep the five-window read quick.
        CALENDAR_BUSY_REQUESTS_PER_SECOND: '100',
        ...extra,
      }),
    );
    const from = Date.parse('2026-11-01T00:00:00.000Z');
    const to = from + 62 * 24 * 60 * 60 * 1000;
    await provider.listBusy({
      connectionRefs: ['conn-a', 'conn-b'],
      fromUtc: new Date(from).toISOString(),
      toUtc: new Date(to).toISOString(),
    });
    return { sent, fromUtc: new Date(from).toISOString(), toUtc: new Date(to).toISOString() };
  }

  it('set to 62, a 62-day read is one request per connection', async () => {
    const { sent, fromUtc, toUtc } = await sixtyTwoDayRead({ CALENDAR_BUSY_WINDOW_DAYS: '62' });
    expect(sent.sort()).toEqual([
      ['conn-a', fromUtc, toUtc],
      ['conn-b', fromUtc, toUtc],
    ]);
  });

  it('left at the default of 14, the same read is five windows per connection, end to end', async () => {
    const { sent, fromUtc, toUtc } = await sixtyTwoDayRead({});
    for (const ref of ['conn-a', 'conn-b']) {
      const windows = sent.filter(([r]) => r === ref).map(([, a, b]) => [a, b]).sort();
      expect(windows).toHaveLength(5);
      expect(windows[0]![0]).toBe(fromUtc);
      expect(windows[4]![1]).toBe(toUtc);
      for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBe(windows[i - 1]![1]);
    }
  });

  it('accepts 1 to 90 days and nothing else', () => {
    expect(loadServerEnv({}).CALENDAR_BUSY_WINDOW_DAYS).toBe(14);
    expect(loadServerEnv({ CALENDAR_BUSY_WINDOW_DAYS: '1' }).CALENDAR_BUSY_WINDOW_DAYS).toBe(1);
    expect(loadServerEnv({ CALENDAR_BUSY_WINDOW_DAYS: '90' }).CALENDAR_BUSY_WINDOW_DAYS).toBe(90);
    for (const bad of ['0', '91', '7.5', 'two']) {
      expect(() => loadServerEnv({ CALENDAR_BUSY_WINDOW_DAYS: bad })).toThrow();
    }
  });
});
