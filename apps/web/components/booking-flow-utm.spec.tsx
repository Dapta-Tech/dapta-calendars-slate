// @vitest-environment jsdom
/**
 * The campaign a booking keeps, from the booking page: the page's own `utm_*`
 * ride the booking form as hidden fields; embedded without any, the page asks
 * the framing page and sends what it answers; nothing at all otherwise.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const actions = vi.hoisted(() => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
  meetingLinkAction: vi.fn(async () => null),
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => actions);
// The navigation itself is jsdom's to refuse; what these specs read is that
// the page ASKS for it, once, with the right URL. `followRedirect` has its own spec.
const navigation = vi.hoisted(() => ({ followRedirect: vi.fn() }));
vi.mock('@/lib/success-redirect', async (original) => ({
  ...(await original<typeof import('@/lib/success-redirect')>()),
  followRedirect: navigation.followRedirect,
}));

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { BASE_STYLE, NOW, TIME_ZONE, availability, booking } from '@/app/[accountCode]/__fixtures__/public-surface';
import { resetConversionsForTests } from '@/lib/booking-conversion';

const fixture = availability();

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Later months are read over the same-origin route; nothing here needs them.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, slots: [] }) })));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  // Answers queued for a call that never came must not reach the next test.
  actions.bookAction.mockReset();
  actions.reserveAction.mockReset();
  const win = window as unknown as { fbq?: unknown; dataLayer?: unknown };
  delete win.fbq;
  delete win.dataLayer;
  window.sessionStorage.clear();
  resetConversionsForTests();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(props: { utm?: Record<string, string> | null; embed?: boolean } = {}, locale = 'en') {
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
            slots={fixture.slots}
            bookingFields={fixture.eventType.bookingFields}
            initialTimeZone={TIME_ZONE}
            locale={locale}
            eventTitle={fixture.eventType.title}
            lengthMinutes={fixture.eventType.lengthMinutes}
            hostName="Riley Chen"
            avatarUrl={null}
            location={fixture.eventType.location}
            nowUtc={NOW}
            showBranding
            utm={props.utm ?? null}
            embed={props.embed ?? false}
          />
        </main>
      </BrandedShell>,
    );
  });
  return container;
}

/** Pick the first time, fill the form, and confirm; the booking write answers `successRedirectUrl`. */
async function book(el: HTMLElement, successRedirectUrl?: string, status: 'accepted' | 'pending' = 'accepted') {
  actions.reserveAction.mockResolvedValueOnce({ ok: true, reservationUid: 'res_1', expiresAt: '2026-03-02T14:10:00.000Z' });
  await act(async () => el.querySelector<HTMLButtonElement>('.bp-slot')!.click());
  const at = el.querySelector<HTMLInputElement>('input[name="startUtc"]')!.value;
  await act(async () => {
    type(el, 'input[name="name"]', 'Sam Visitor');
    type(el, 'input[name="email"]', 'sam@example.com');
    type(el, 'input[name="answer_company"]', 'Example Co');
  });
  actions.bookAction.mockResolvedValueOnce({
    ok: true,
    status: 201,
    booking: booking({
      status,
      startUtc: at,
      endUtc: new Date(Date.parse(at) + 45 * 60_000).toISOString(),
      ...(successRedirectUrl !== undefined ? { successRedirectUrl } : {}),
    }),
  });
  await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
}

const sentUtm = () => {
  const form = actions.bookAction.mock.calls.at(-1)?.[1] as FormData | undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of form?.entries() ?? []) if (key.startsWith('utm_')) out[key] = String(value);
  return out;
};

describe('the booking form carries the campaign', () => {
  it('the page’s own UTMs, as hidden fields', async () => {
    const el = await mount({ utm: { utm_source: 'google', utm_campaign: 'q4' } });
    await book(el);
    expect(sentUtm()).toEqual({ utm_source: 'google', utm_campaign: 'q4' });
  });

  it('nothing on a page without UTMs', async () => {
    const el = await mount();
    await book(el);
    expect(actions.bookAction).toHaveBeenCalledTimes(1);
    expect(sentUtm()).toEqual({});
  });

  it('embedded without its own: the framing page’s answer', async () => {
    const el = await mount({ embed: true });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'dapta-calendars:context', utm: { utm_source: 'newsletter', utm_medium: 'email' } },
          source: window.parent,
        }),
      );
    });
    await book(el);
    expect(sentUtm()).toEqual({ utm_source: 'newsletter', utm_medium: 'email' });
  });

  it('embedded with its own: its own, never mixed with the framing page’s', async () => {
    const el = await mount({ embed: true, utm: { utm_source: 'google' } });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'dapta-calendars:context', utm: { utm_medium: 'email' } },
          source: window.parent,
        }),
      );
    });
    await book(el);
    expect(sentUtm()).toEqual({ utm_source: 'google' });
  });
});
