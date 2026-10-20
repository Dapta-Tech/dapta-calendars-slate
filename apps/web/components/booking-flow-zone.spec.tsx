// @vitest-environment jsdom
/**
 * The zone the times open in. A visitor reads them in their OWN zone, the
 * browser's, without opening the picker: someone in Miami booking a host in
 * Bogota used to see Bogota times and had to find the picker. The host's zone
 * is only the fallback, for a browser that hides its zone (UTC) or reports one
 * this runtime cannot use, so the control is never blank.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const browser = vi.hoisted(() => ({ zone: 'UTC' }));
vi.mock('@slate/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slate/shared')>()),
  detectTimeZone: () => browser.zone,
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import type { AvailabilityChunk } from '@/lib/availability-source';
import { firstWindow, monthSpan } from '@/lib/availability-window';
import { BASE_STYLE, NOW, TIME_ZONE, availability } from '@/app/[accountCode]/__fixtures__/public-surface';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout engine; `scrollIntoView` is a no-op there.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  browser.zone = 'UTC';
});

interface FlowOptions {
  /** Hands the page the server's first read instead of every slot. */
  progressive?: { initial: Promise<AvailabilityChunk> };
  initialTimeZone?: string;
  followBrowserZone?: boolean;
}

function flow({ progressive, initialTimeZone = TIME_ZONE, followBrowserZone }: FlowOptions = {}) {
  const a = availability();
  const span = firstWindow(TIME_ZONE, Date.parse(NOW));
  return (
    <BrandedShell brandColor="#2f6fed" style={{ ...BASE_STYLE, theme: 'light' }} className="bp-viewport">
      <main>
        <BookingFlow
          accountCode="northwind"
          ownerSlug="riley-chen"
          slug="design-review"
          {...(progressive
            ? {
                availability: {
                  initial: progressive.initial,
                  window: { from: new Date(span.fromMs).toISOString(), to: new Date(span.toMs).toISOString() },
                  source: { kind: 'personal', accountCode: 'northwind', owner: 'riley-chen', slug: 'design-review' },
                },
              }
            : { slots: a.slots })}
          bookingFields={a.eventType.bookingFields}
          initialTimeZone={initialTimeZone}
          followBrowserZone={followBrowserZone}
          locale="en"
          eventTitle={a.eventType.title}
          lengthMinutes={a.eventType.lengthMinutes}
          hostName="Riley Chen"
          avatarUrl={null}
          location={a.eventType.location}
          nowUtc={NOW}
          showBranding
        />
      </main>
    </BrandedShell>
  );
}

async function mount(zone: string, options?: FlowOptions) {
  browser.zone = zone;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(flow(options));
  });
  return container;
}

const zoneControl = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('#tz')!.textContent ?? '';

describe('the zone the times open in', () => {
  it("is the browser's, not the host's, with no picker opened", async () => {
    const el = await mount('Europe/Madrid');
    expect(zoneControl(el)).toMatch(/madrid/i);
    // The host's zone stays a fact about the host, beside the event.
    expect(el.textContent).toMatch(/new york, the host's time/i);
  });

  it.each(['UTC', 'Etc/UTC', 'Etc/Universal', 'Zulu', 'GMT', 'Etc/GMT'])(
    "falls back to the host's when the browser hides its zone (%s)",
    async (zone) => {
      const el = await mount(zone);
      expect(zoneControl(el)).toMatch(/new york/i);
    },
  );

  it("falls back to the host's when the browser reports a zone this runtime cannot use", async () => {
    const el = await mount('Mars/Olympus_Mons');
    expect(zoneControl(el)).toMatch(/new york/i);
  });

  it('never overwrites a zone the visitor picked', async () => {
    const el = await mount('Europe/Madrid');
    await act(async () => el.querySelector<HTMLButtonElement>('#tz')!.click());
    const tokyo = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      /tokyo/i.test(o.textContent ?? ''),
    )!;
    await act(async () => tokyo.click());
    expect(zoneControl(el)).toMatch(/tokyo/i);
    // The page is handed a new host zone while mounted: the visitor's pick stays.
    await act(async () => {
      root!.render(flow({ initialTimeZone: 'America/Chicago' }));
    });
    expect(zoneControl(el)).toMatch(/tokyo/i);
  });

  it("stays in the host's zone when told not to follow the browser (the brand preview)", async () => {
    const el = await mount('Europe/Madrid', { initialTimeZone: 'UTC', followBrowserZone: false });
    expect(zoneControl(el)).toMatch(/utc/i);
  });
});

describe('a visitor west of the host', () => {
  const fetchMock = vi.fn();
  beforeAll(() => vi.stubGlobal('fetch', fetchMock));
  afterAll(() => vi.unstubAllGlobals());

  it("has their whole visible month in the server's first read: nothing in it is read again", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true, slots: [] }) }));
    const a = availability();
    await mount('America/Los_Angeles', { progressive: { initial: Promise.resolve({ ok: true, slots: a.slots }) } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(zoneControl(container!)).toMatch(/los angeles/i);
    // Reading ahead into April is expected; a read that starts inside the
    // visible month (Los Angeles' March) is the extra round trip this pins.
    const marchEndsInLosAngeles = monthSpan('2026-03', 'America/Los_Angeles').toMs;
    const starts = fetchMock.mock.calls.map(([url]) =>
      Date.parse(new URL(url as string, 'http://localhost').searchParams.get('from')!),
    );
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((from) => from >= marchEndsInLosAngeles)).toBe(true);
  });
});
