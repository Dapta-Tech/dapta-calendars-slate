// @vitest-environment jsdom
/**
 * The two event-page steps a static render cannot reach, pinned as markup: the
 * details form (after a time is picked) and the confirmation (after a booking
 * lands). Same contract as `public-markup.spec.tsx`: written by the renderer at
 * the base of the redesign, and changed only on purpose, with the diff
 * explained in the PR that changes it.
 *
 * The island is driven the way a visitor drives it: click a time, type, submit.
 * The server actions are stubbed at the module boundary, so nothing here talks
 * to an API.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const env = vi.hoisted(() => {
  const saved = {
    NEXT_PUBLIC_SIGNUP_URL: process.env.NEXT_PUBLIC_SIGNUP_URL,
    NEXT_PUBLIC_HIDE_BADGE: process.env.NEXT_PUBLIC_HIDE_BADGE,
    NEXT_PUBLIC_PRODUCT_NAME: process.env.NEXT_PUBLIC_PRODUCT_NAME,
    TZ: process.env.TZ,
  };
  // The hold countdown formats in the PROCESS time zone, so a snapshot written
  // in one city would fail in another (or on CI) without this.
  process.env.TZ = 'America/New_York';
  process.env.NEXT_PUBLIC_SIGNUP_URL = 'https://example.com/signup';
  delete process.env.NEXT_PUBLIC_HIDE_BADGE;
  process.env.NEXT_PUBLIC_PRODUCT_NAME = 'Dapta Calendars';
  return saved;
});

const actions = vi.hoisted(() => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => actions);

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { CANVASES, BASE_STYLE, NOW, TIME_ZONE, availability, booking, pretty } from './__fixtures__/public-surface';

const SNAP = './__snapshots__/public-markup';

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
  vi.clearAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function mount(theme: (typeof CANVASES)[number]) {
  const a = availability();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <BrandedShell brandColor="#2f6fed" style={{ ...BASE_STYLE, theme }} className="bp-viewport">
        <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
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
            description="Bring a screen or a flow."
            hostName="Riley Chen"
            avatarUrl={null}
            location={a.eventType.location}
            nowUtc={NOW}
          />
        </main>
      </BrandedShell>,
    );
  });
  return container;
}

async function pickFirstTime(el: HTMLElement) {
  actions.reserveAction.mockResolvedValue({
    ok: true,
    reservationUid: 'res_pinned',
    expiresAt: '2026-03-02T14:10:00.000Z',
  });
  const slot = el.querySelector<HTMLButtonElement>('.bp-slot');
  expect(slot).not.toBeNull();
  await act(async () => {
    slot!.click();
  });
}

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the details step renders byte for byte', () => {
  for (const theme of CANVASES) {
    it(theme, async () => {
      const el = await mount(theme);
      await pickFirstTime(el);
      expect(el.querySelector('input[name="name"]')).not.toBeNull();
      await expect(pretty(el.innerHTML)).toMatchFileSnapshot(`${SNAP}/details-${theme}.html`);
    });
  }
});

describe('the confirmation renders byte for byte', () => {
  for (const theme of CANVASES) {
    it(theme, async () => {
      const el = await mount(theme);
      await pickFirstTime(el);
      actions.bookAction.mockResolvedValue({ ok: true, booking: booking({ startUtc: '2026-03-02T14:30:00.000Z' }) });
      await act(async () => {
        type(el, 'input[name="name"]', 'Sam Visitor');
        type(el, 'input[name="email"]', 'sam@example.com');
        type(el, 'input[name="answer_company"]', 'Example Co');
      });
      await act(async () => {
        el.querySelector<HTMLFormElement>('form')!.requestSubmit();
      });
      expect(actions.bookAction).toHaveBeenCalledTimes(1);
      expect(el.querySelector('input[name="name"]')).toBeNull();
      await expect(pretty(el.innerHTML)).toMatchFileSnapshot(`${SNAP}/confirmation-${theme}.html`);
    });
  }
});
