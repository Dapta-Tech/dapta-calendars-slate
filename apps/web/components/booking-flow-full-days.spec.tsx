// @vitest-environment jsdom
/**
 * A day a booking limit has closed reads "Full" on the booking page, not as a
 * blank day: the API lists its times as `fullSlots`, and a day that has some
 * of those and no time left to book is drawn full, still not a control. A day
 * with no hours at all stays plain. English and Spanish.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => ({ bookAction: vi.fn(), reserveAction: vi.fn(), releaseAction: vi.fn() }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, slots: [] }) })));

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { BASE_STYLE, NOW, TIME_ZONE, availability } from '@/app/[accountCode]/__fixtures__/public-surface';

let root: Root | null = null;
let container: HTMLElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = null;
});

/** Wednesday March 4 (New York) is full: its times move from `slots` to `fullSlots`. */
const WEDNESDAY = '2026-03-04';
const fixture = availability();
const isWednesday = (s: { startUtc: string }) => s.startUtc.startsWith(WEDNESDAY);

async function mount(locale: string) {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  const initial = Promise.resolve({
    ok: true as const,
    slots: fixture.slots.filter((s) => !isWednesday(s)),
    fullSlots: fixture.slots.filter(isWednesday).map((s) => s.startUtc),
  });
  await act(async () => {
    root!.render(
      <BrandedShell brandColor="#2f6fed" style={{ ...BASE_STYLE, theme: 'light' }} className="bp-viewport">
        <BookingFlow
          accountCode="northwind" ownerSlug="riley-chen" slug="design-review"
          availability={{ initial, window: { from: NOW, to: '2026-04-01T04:00:00.000Z' }, source: { kind: 'personal', accountCode: 'northwind', owner: 'riley-chen', slug: 'design-review' } }}
          initialTimeZone={TIME_ZONE} locale={locale} eventTitle="Design review" lengthMinutes={45} description={null}
          hostName="Riley Chen" avatarUrl={null} location={fixture.eventType.location} nowUtc={NOW} showBranding
        />
      </BrandedShell>,
    );
    await initial;
  });
  return container;
}

describe('a full day on the booking page', () => {
  for (const locale of ['en', 'es'] as const) {
    it(`is drawn "${getMessages(locale).bookingPage.dayFull}", not as a blank day, and cannot be picked (${locale})`, async () => {
      const el = await mount(locale);
      const full = el.querySelector<HTMLButtonElement>(`[data-day="${WEDNESDAY}"]`)!;
      expect(full.dataset.state).toBe('full');
      expect(full.disabled).toBe(true);
      expect(full.textContent).toContain(getMessages(locale).bookingPage.dayFull);
      expect(full.getAttribute('aria-label')).toContain(getMessages(locale).bookingPage.dayFull);
      // A weekend has no hours at all: plain, no "Full".
      const saturday = el.querySelector<HTMLButtonElement>('[data-day="2026-03-07"]')!;
      expect(saturday.dataset.state).toBe('empty');
      expect(el.querySelectorAll('[data-state="full"]')).toHaveLength(1);
    });
  }
});
