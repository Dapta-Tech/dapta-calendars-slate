// @vitest-environment jsdom
/**
 * The zone the times open in. A visitor reads them in their OWN zone, the
 * browser's, without opening the picker: someone in Miami booking a host in
 * Bogota used to see Bogota times and had to find the picker. The host's zone
 * is only the fallback, for a browser that hides its zone (UTC) or reports one
 * this runtime cannot use, so the control is never blank.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { BASE_STYLE, NOW, TIME_ZONE, availability } from '@/app/[accountCode]/__fixtures__/public-surface';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  browser.zone = 'UTC';
});

async function mount(zone: string) {
  browser.zone = zone;
  const a = availability();
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
            slots={a.slots}
            bookingFields={a.eventType.bookingFields}
            initialTimeZone={TIME_ZONE}
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
      </BrandedShell>,
    );
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

  it("falls back to the host's when the browser hides its zone", async () => {
    const el = await mount('UTC');
    expect(zoneControl(el)).toMatch(/new york/i);
  });

  it("falls back to the host's when the browser reports a zone this runtime cannot use", async () => {
    const el = await mount('Mars/Olympus_Mons');
    expect(zoneControl(el)).toMatch(/new york/i);
  });
});
