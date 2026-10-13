// @vitest-environment jsdom
/**
 * The event page paints before it knows a single time (Phase 5).
 *
 * The server streams the visible month's read into the island instead of
 * waiting on it, and the island reads every other month itself. These pin the
 * three promises that makes to a visitor: the month is drawn at once with its
 * days in a quiet "not yet known" state and no spinner; the days settle IN
 * PLACE (the same grid, the same cells) when the times land; and the reads go
 * in the right order, visible month first, the next one as soon as it lands or
 * the moment the visitor points at it, later months only when visited.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages, type Slot } from '@slate/shared';

vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import type { AvailabilityChunk } from '@/lib/availability-source';
import { RETRY_DELAYS_MS, retryDelay } from '@/lib/use-progressive-slots';
import { BASE_STYLE, NOW, TIME_ZONE, availability } from '@/app/[accountCode]/__fixtures__/public-surface';

const fixture = availability();
/** The fixture's three weeks of times, all in March (the visible month). */
const MARCH: Slot[] = fixture.slots;
/** Weekday mornings in April, for a host whose times start next month. */
const APRIL: Slot[] = ['2026-04-06T14:00:00.000Z', '2026-04-07T14:00:00.000Z'].map((startUtc) => ({ startUtc }));
const FIRST = { from: NOW, to: '2026-04-01T04:00:00.000Z' };

let root: Root | null = null;
let container: HTMLElement | null = null;
const fetchMock = vi.fn();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A read the test answers by hand, so it can look at the page before it lands. */
function deferred() {
  let resolve!: (c: AvailabilityChunk) => void;
  const promise = new Promise<AvailabilityChunk>((r) => (resolve = r));
  return { promise, resolve };
}

/** What the same-origin route answers for a later month. */
function answerLaterMonths(slotsFor: (from: string, to: string) => Slot[] = () => []) {
  fetchMock.mockImplementation(async (url: string) => {
    const q = new URL(url, 'http://localhost').searchParams;
    const chunk: AvailabilityChunk = { ok: true, slots: slotsFor(q.get('from')!, q.get('to')!) };
    return { ok: true, json: async () => chunk };
  });
}

/** The windows the island asked the route for, in order. */
function reads(): Array<{ from: string; to: string }> {
  return fetchMock.mock.calls.map(([url]) => {
    const q = new URL(url as string, 'http://localhost').searchParams;
    return { from: q.get('from')!, to: q.get('to')! };
  });
}

async function mount(initial: Promise<AvailabilityChunk>, locale = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <BrandedShell brandColor="#2f6fed" style={{ ...BASE_STYLE, theme: 'light' }} className="bp-viewport">
        <main>
          <BookingFlow
            accountCode="northwind"
            ownerSlug="riley-chen"
            slug="design-review"
            availability={{
              initial,
              window: FIRST,
              source: { kind: 'personal', accountCode: 'northwind', owner: 'riley-chen', slug: 'design-review' },
            }}
            initialTimeZone={TIME_ZONE}
            locale={locale}
            eventTitle={fixture.eventType.title}
            lengthMinutes={fixture.eventType.lengthMinutes}
            description="Bring a screen or a flow."
            hostName="Riley Chen"
            avatarUrl={null}
            location={fixture.eventType.location}
            nowUtc={NOW}
            showBranding
          />
        </main>
      </BrandedShell>,
    );
  });
  return container;
}

async function land(d: ReturnType<typeof deferred>, chunk: AvailabilityChunk) {
  await act(async () => {
    d.resolve(chunk);
    await d.promise;
  });
}

const day = (el: HTMLElement, key: string) => el.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)!;
const dayKeys = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-day]')].map((d) => d.dataset.day);
const monthLabel = (el: HTMLElement) => el.querySelector('.bp-cal-grid')!.getAttribute('aria-label');

describe('the month is drawn before any time is known', () => {
  it('paints the event and the whole month, its days not yet known, with no spinner', async () => {
    answerLaterMonths();
    const el = await mount(deferred().promise);

    expect(el.querySelector('.bp-pane-event')!.textContent).toContain('Design review');
    const grid = el.querySelector('.bp-cal-grid')!;
    expect(grid.getAttribute('aria-label')).toBe('March 2026');
    expect(grid.getAttribute('aria-busy')).toBe('true');
    // Today onward: not yet known, and not a control yet. The 1st is past.
    for (const key of ['2026-03-02', '2026-03-07', '2026-03-31']) {
      expect(day(el, key).dataset.state).toBe('pending');
      expect(day(el, key).disabled).toBe(true);
    }
    expect(day(el, '2026-03-01').dataset.state).toBe('empty');
    expect(el.querySelectorAll('[data-state="available"]')).toHaveLength(0);

    // The times column holds its shape with quiet rows, and says nothing it
    // does not know: no "no times" sentence, no empty-page sentence.
    const times = el.querySelector('.bp-times')!;
    expect(times.getAttribute('aria-busy')).toBe('true');
    expect(times.querySelectorAll('.bp-slot-placeholder')).toHaveLength(6);
    expect(times.querySelector('[role="status"]')!.textContent).toBe('Finding the times available this month.');
    expect(el.querySelector('.bp-empty')).toBeNull();

    // No spinner of any kind: the only progress element is the step track.
    expect(el.querySelector('[class*="spin"]')).toBeNull();
    expect([...el.querySelectorAll('[role="progressbar"]')].every((p) => p.classList.contains('bp-progress'))).toBe(true);

    // The visible month is already in flight from the server: nothing else is read yet.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says it in Spanish too', async () => {
    const el = await mount(deferred().promise, 'es');
    expect(el.querySelector('.bp-times [role="status"]')!.textContent).toBe(
      'Buscando los horarios disponibles de este mes.',
    );
  });

  it('settles in place: the same grid and the same cells, now bookable or not', async () => {
    answerLaterMonths();
    const first = deferred();
    const el = await mount(first.promise);
    const grid = el.querySelector('.bp-cal-grid');
    const times = el.querySelector('.bp-pane-times');
    const before = dayKeys(el);

    await land(first, { ok: true, slots: MARCH, bookingFields: fixture.eventType.bookingFields });

    expect(el.querySelector('.bp-cal-grid')).toBe(grid);
    expect(el.querySelector('.bp-pane-times')).toBe(times);
    expect(dayKeys(el)).toEqual(before);
    expect(grid!.hasAttribute('aria-busy')).toBe(false);
    expect(day(el, '2026-03-02').dataset.state).toBe('available');
    expect(day(el, '2026-03-07').dataset.state).toBe('empty');
    expect(el.querySelectorAll('[data-state="pending"]')).toHaveLength(0);
    expect(el.querySelectorAll('.bp-slot-placeholder')).toHaveLength(0);
    expect(el.querySelectorAll('.bp-times .bp-slot').length).toBeGreaterThan(0);
  });
});

describe('the reads go in the order a visitor needs them', () => {
  const APRIL_WINDOW = { from: '2026-04-01T04:00:00.000Z', to: '2026-05-01T04:00:00.000Z' };
  // The booking horizon is 60 days from now, so May is read only up to it.
  const MAY_WINDOW = { from: '2026-05-01T04:00:00.000Z', to: '2026-05-01T14:00:00.000Z' };

  it('the next month is read as soon as the visible one lands', async () => {
    answerLaterMonths();
    const first = deferred();
    await mount(first.promise);
    expect(reads()).toEqual([]);
    await land(first, { ok: true, slots: MARCH });
    expect(reads()).toEqual([APRIL_WINDOW]);
  });

  it('pointing at "next" reads it straight away, and only once', async () => {
    answerLaterMonths();
    const first = deferred();
    const el = await mount(first.promise);
    const next = el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!;
    await act(async () => next.focus());
    expect(reads()).toEqual([APRIL_WINDOW]);
    await land(first, { ok: true, slots: MARCH });
    expect(reads()).toEqual([APRIL_WINDOW]);
  });

  it('later months are read when visited, and a month in hand is never read again', async () => {
    answerLaterMonths();
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: MARCH });
    const click = async (label: string) =>
      act(async () => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());

    await click('Next month');
    expect(monthLabel(el)).toBe('April 2026');
    await click('Next month');
    expect(monthLabel(el)).toBe('May 2026');
    await click('Previous month');
    await click('Previous month');
    expect(monthLabel(el)).toBe('March 2026');
    expect(reads()).toEqual([APRIL_WINDOW, MAY_WINDOW]);
  });

  it('a host whose times start next month opens on that month, as it always did', async () => {
    answerLaterMonths((from) => (from.startsWith('2026-04') ? APRIL : []));
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: [] });
    await act(async () => {});
    expect(monthLabel(el)).toBe('April 2026');
    expect(day(el, '2026-04-06').dataset.state).toBe('available');
  });
});

describe('"next day with times" names only a day the page can vouch for', () => {
  it('never skips a month that could not be read', async () => {
    // April cannot be read; May (up to the horizon) has a time.
    const MAY: Slot[] = [{ startUtc: '2026-05-01T13:00:00.000Z' }];
    fetchMock.mockImplementation(async (url: string) => {
      const from = new URL(url, 'http://localhost').searchParams.get('from')!;
      if (from.startsWith('2026-04')) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ ok: true, slots: MAY }) };
    });
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: MARCH });
    const click = async (label: string) =>
      act(async () => el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    await click('Next month');
    await click('Next month');
    expect(monthLabel(el)).toBe('May 2026');
    await click('Previous month');
    await click('Previous month');
    // The last day in March with times. May's time is known, but April is not,
    // so the page cannot say May is the next day with times.
    const lastInMarch = [...el.querySelectorAll<HTMLButtonElement>('[data-state="available"]')].pop()!;
    await act(async () => lastInMarch.click());
    expect(el.querySelector('.bp-next-day')).toBeNull();
  });
});

describe('a month that cannot be read is never shown as a month with no times', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`the visible month failing says the times are unavailable (${locale})`, async () => {
      answerLaterMonths();
      const first = deferred();
      const el = await mount(first.promise, locale);
      await land(first, { ok: false });
      expect(el.querySelector('.bp-empty')!.textContent).toBe(getMessages(locale).booking.timesUnavailable);
      expect(el.querySelector('.bp-cal-grid')).toBeNull();
    });
  }

  it('an empty visible month and a failed next month keep the calendar, never the unavailable sentence', async () => {
    let fail = true;
    fetchMock.mockImplementation(async () =>
      fail ? { ok: false, json: async () => ({ ok: false }) } : { ok: true, json: async () => ({ ok: true, slots: APRIL }) },
    );
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: [] });
    await act(async () => {});
    expect(el.querySelector('.bp-empty')).toBeNull();
    expect(monthLabel(el)).toBe('March 2026');
    fail = false;
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    await act(async () => {});
    expect(monthLabel(el)).toBe('April 2026');
    expect(day(el, '2026-04-06').dataset.state).toBe('available');
  });

  it('a later month failing stays not yet known, and is asked again when visited', async () => {
    let fail = true;
    fetchMock.mockImplementation(async () =>
      fail ? { ok: false, json: async () => ({ ok: false }) } : { ok: true, json: async () => ({ ok: true, slots: APRIL }) },
    );
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: MARCH });
    await act(async () => {});
    fail = false;
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    await act(async () => {});
    expect(monthLabel(el)).toBe('April 2026');
    expect(day(el, '2026-04-06').dataset.state).toBe('available');
    // April failed, April again on the visit, then May as April settled.
    expect(reads().map((r) => r.from)).toEqual([
      '2026-04-01T04:00:00.000Z',
      '2026-04-01T04:00:00.000Z',
      '2026-05-01T04:00:00.000Z',
    ]);
  });
});

/**
 * A read that fails once must not strand the visitor. The visible month used to
 * fail into the "times unavailable" sentence and never ask again (nothing did
 * unless the visitor moved, and with the sentence in place of the calendar
 * there was nowhere to move), so a passing API error ended the page.
 */
describe('a failed read is asked again on its own, a bounded number of times', () => {
  /** A March day the fixture offers times on. */
  const MARCH_DAY = '2026-03-02';
  const failing = () => ({ ok: false, json: async () => ({ ok: false }) });
  const sameWindow = (r: { from: string; to: string }, w: { from: string; to: string }) =>
    Date.parse(r.from) === Date.parse(w.from) && Date.parse(r.to) === Date.parse(w.to);
  /** Let a retry's timer fire, then its read land and render. */
  async function wait(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await act(async () => {});
  }

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The jitter at its midpoint, so each wait is exactly its base delay.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterAll(() => {
    vi.mocked(Math.random).mockRestore();
    vi.useRealTimers();
  });

  it('spreads each wait over half to one and a half times its base, and stops after the last', () => {
    expect(retryDelay(0, () => 0)).toBe(RETRY_DELAYS_MS[0]! / 2);
    expect(retryDelay(4, () => 0.5)).toBe(RETRY_DELAYS_MS[4]);
    expect(retryDelay(4, () => 0.999)).toBeLessThan(RETRY_DELAYS_MS[4]! * 1.5);
    expect(retryDelay(RETRY_DELAYS_MS.length)).toBeUndefined();
  });

  it('a window the route refuses as such (400, 404) is not asked again', async () => {
    for (const status of [400, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => ({ ok: false, status, json: async () => ({ error: 'X' }) }));
      const first = deferred();
      await mount(first.promise);
      await land(first, { ok: true, slots: MARCH });
      await act(async () => {});
      expect(reads(), String(status)).toHaveLength(1);
      await wait(5 * 60_000);
      expect(reads(), String(status)).toHaveLength(1);
      act(() => root?.unmount());
      root = null;
      container?.remove();
    }
  });

  it('the visible month failing comes back: asked again after a second, the calendar returns', async () => {
    answerLaterMonths((from) => (Date.parse(from) < Date.parse(FIRST.to) ? MARCH : []));
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    expect(el.querySelector('.bp-empty')!.textContent).toBe(getMessages('en').booking.timesUnavailable);
    expect(reads()).toEqual([]);

    await wait(RETRY_DELAYS_MS[0]!);
    expect(sameWindow(reads()[0]!, FIRST)).toBe(true);
    expect(el.querySelector('.bp-empty')).toBeNull();
    expect(monthLabel(el)).toBe('March 2026');
    expect(day(el, MARCH_DAY).dataset.state).toBe('available');
  });

  it('an outage is asked five more times, backing off, then left alone with the sentence', async () => {
    fetchMock.mockImplementation(async () => failing());
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      await wait(delay - 1);
      expect(reads(), `before retry ${i + 1}`).toHaveLength(i);
      await wait(1);
      expect(reads(), `retry ${i + 1}`).toHaveLength(i + 1);
    }
    await wait(5 * 60_000);
    expect(reads()).toHaveLength(RETRY_DELAYS_MS.length);
    expect(reads().every((r) => sameWindow(r, FIRST))).toBe(true);
    expect(el.querySelector('.bp-empty')!.textContent).toBe(getMessages('en').booking.timesUnavailable);
  });

  it('is retried even when the next month was read beside it (no merged span claims it is still in flight)', async () => {
    let failMarch = true;
    fetchMock.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://localhost').searchParams;
      const march = Date.parse(q.get('from')!) < Date.parse(FIRST.to);
      if (march && failMarch) return failing();
      return { ok: true, json: async () => ({ ok: true, slots: march ? MARCH : [] }) };
    });
    const first = deferred();
    const el = await mount(first.promise);
    // April is asked for while March is still in flight: adjacent windows.
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.focus());
    await land(first, { ok: false });
    failMarch = false;
    await wait(RETRY_DELAYS_MS[0]!);
    expect(reads().some((r) => sameWindow(r, FIRST))).toBe(true);
    expect(monthLabel(el)).toBe('March 2026');
    expect(day(el, MARCH_DAY).dataset.state).toBe('available');
  });

  it('a later month that failed on screen settles on its own', async () => {
    let failApril = true;
    fetchMock.mockImplementation(async (url: string) => {
      const april = new URL(url, 'http://localhost').searchParams.get('from') === '2026-04-01T04:00:00.000Z';
      if (april && failApril) return failing();
      return { ok: true, json: async () => ({ ok: true, slots: april ? APRIL : [] }) };
    });
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: MARCH });
    await act(async () => {});
    // The visitor goes to April while its read is failing: it stays unsettled.
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click());
    await act(async () => {});
    expect(monthLabel(el)).toBe('April 2026');
    expect(day(el, '2026-04-06').dataset.state).not.toBe('available');
    failApril = false;
    await wait(RETRY_DELAYS_MS[1]!);
    expect(day(el, '2026-04-06').dataset.state).toBe('available');
  });

  it('past the last retry, "Try again" asks once more and the calendar returns', async () => {
    let up = false;
    fetchMock.mockImplementation(async (url: string) => {
      const from = new URL(url, 'http://localhost').searchParams.get('from')!;
      if (!up) return failing();
      return { ok: true, json: async () => ({ ok: true, slots: Date.parse(from) < Date.parse(FIRST.to) ? MARCH : [] }) };
    });
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    for (const delay of RETRY_DELAYS_MS) await wait(delay);
    expect(reads()).toHaveLength(RETRY_DELAYS_MS.length);
    expect(vi.getTimerCount()).toBe(0);
    const button = el.querySelector<HTMLButtonElement>('.bp-empty + button')!;
    expect(button.textContent).toBe(getMessages('en').booking.retry);
    expect(el.querySelector('.bp-empty')!.getAttribute('role')).toBe('status');
    // Busy while it asks: one press, one read.
    let answer!: () => void;
    fetchMock.mockImplementationOnce(
      (url: string) =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, json: async () => ({ ok: true, slots: MARCH }) });
          void url;
        }),
    );
    up = true;
    button.focus();
    await act(async () => button.click());
    // Busy, and still focusable (aria-disabled, not disabled).
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    // A second press while it asks reads nothing more.
    const before = reads().length;
    await act(async () => button.click());
    expect(reads()).toHaveLength(before);
    await act(async () => {
      answer();
    });
    await act(async () => {});
    // The visible month once more (then the next one, as it settles).
    expect(sameWindow(reads()[RETRY_DELAYS_MS.length]!, FIRST)).toBe(true);
    expect(el.querySelector('.bp-empty')).toBeNull();
    expect(day(el, MARCH_DAY).dataset.state).toBe('available');
    // Focus lands on the calendar, not on the page the button left.
    expect((document.activeElement as HTMLElement | null)?.dataset.day).toMatch(/^2026-03-/);
  });

  it('a press that still finds nothing says so, keeps focus on the button, and can be pressed again', async () => {
    fetchMock.mockImplementation(async () => failing());
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    for (const delay of RETRY_DELAYS_MS) await wait(delay);
    const button = el.querySelector<HTMLButtonElement>('.bp-empty + button')!;
    button.focus();
    await act(async () => button.click());
    await act(async () => {});
    expect(el.querySelector('.bp-empty')!.textContent).toBe(getMessages('en').booking.timesStillUnavailable);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBeNull();
    const before = reads().length;
    await act(async () => button.click());
    await act(async () => {});
    expect(reads()).toHaveLength(before + 1);
  });

  it('"Try again" pressed while a retry is already out waits for that read', async () => {
    let answer!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: true, json: async () => ({ ok: true, slots: MARCH }) });
        }),
    );
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    // The automatic retry goes out and has not answered.
    await act(async () => {
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0]!);
    });
    expect(reads()).toHaveLength(1);
    const button = el.querySelector<HTMLButtonElement>('.bp-empty + button')!;
    await act(async () => button.click());
    // No second read of the same month, and busy until the one out answers.
    expect(reads()).toHaveLength(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      answer();
    });
    await act(async () => {});
    expect(el.querySelector('.bp-empty')).toBeNull();
  });

  it('a visible month that failed, then answered with a reason, says the reason, not "unavailable"', async () => {
    let failed = false;
    fetchMock.mockImplementation(async () =>
      failed ? { ok: true, json: async () => ({ ok: true, slots: [], emptyReason: 'NO_AVAILABILITY' }) } : failing(),
    );
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    failed = true;
    await wait(RETRY_DELAYS_MS[0]!);
    expect(el.querySelector('.bp-empty')!.textContent).toBe(getMessages('en').booking.noTimesNow);
    expect(el.querySelector('.bp-empty + button')).toBeNull();
  });

  it('no "Try again" when the page knows there is nothing to offer', async () => {
    answerLaterMonths();
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: true, slots: [], emptyReason: 'NO_AVAILABILITY' });
    expect(el.querySelector('.bp-empty')).not.toBeNull();
    expect(el.querySelector('.bp-empty + button')).toBeNull();
  });

  it('one window has one retry waiting, however many of its reads fail', async () => {
    fetchMock.mockImplementation(async () => failing());
    const first = deferred();
    const el = await mount(first.promise);
    await land(first, { ok: false });
    expect(vi.getTimerCount()).toBe(1);
    // The visitor asks for the same month by hand while its retry waits.
    await act(async () => el.querySelector<HTMLButtonElement>('.bp-empty + button')!.click());
    await act(async () => {});
    expect(reads()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a page that goes away cancels what it was waiting to ask', async () => {
    fetchMock.mockImplementation(async () => failing());
    const first = deferred();
    await mount(first.promise);
    await land(first, { ok: false });
    expect(vi.getTimerCount()).toBe(1);
    act(() => root?.unmount());
    root = null;
    // The waiting retry is cancelled, not merely ignored when it fires.
    expect(vi.getTimerCount()).toBe(0);
    await wait(60_000);
    expect(reads()).toEqual([]);
  });
});
