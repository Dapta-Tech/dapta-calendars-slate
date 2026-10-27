// @vitest-environment jsdom
/**
 * Redirect after booking, on the booking page: the booking write answers the
 * event's URL, and the page sends the invitee there, once per booking, accepted
 * or pending, with a line and a Continue link on the confirmation for the
 * moment the next page takes (and for an embed the browser did not let move the
 * window). No URL, or one that is not https, and the confirmation stays exactly
 * as it was.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

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

const fixture = availability();
const URL_OK = 'https://www.example.com/thanks?from=calendar';

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
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(locale = 'en') {
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

const continueLink = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === getMessages('en').bookingPage.redirectContinue);

describe('redirect after booking', () => {
  it('sends the invitee to the URL once the booking lands, once, and says where on the confirmation', async () => {
    const el = await mount();
    expect(navigation.followRedirect).not.toHaveBeenCalled();
    await book(el, URL_OK);
    expect(navigation.followRedirect).toHaveBeenCalledTimes(1);
    expect(navigation.followRedirect).toHaveBeenCalledWith(URL_OK);
    expect(el.textContent).toContain('Taking you to example.com.');
    // The way on when the browser did not move: it leaves a frame (`_top`).
    const link = continueLink(el)!;
    expect(link.getAttribute('href')).toBe(URL_OK);
    expect(link.getAttribute('target')).toBe('_top');
    // The booking page's address (a one-off link carries its token in it) never rides along.
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    // A later render of the same confirmation asks for nothing more.
    await act(async () => el.querySelector<HTMLAnchorElement>('a[download]')?.dispatchEvent(new Event('focus')));
    expect(navigation.followRedirect).toHaveBeenCalledTimes(1);
    // The confirmation keeps its own actions.
    expect(el.querySelector('a[download]')).not.toBeNull();
  });

  it('redirects a request that waits for the host too', async () => {
    const el = await mount();
    await book(el, URL_OK, 'pending');
    expect(navigation.followRedirect).toHaveBeenCalledWith(URL_OK);
    expect(el.textContent).toContain(getMessages('en').booking.requested);
  });

  it('says it in Spanish on a Spanish page', async () => {
    const el = await mount('es');
    await book(el, URL_OK);
    expect(el.textContent).toContain('Te llevamos a example.com.');
    expect(el.textContent).toContain('Continuar');
  });

  it('changes nothing for an event without one', async () => {
    const el = await mount();
    await book(el);
    expect(navigation.followRedirect).not.toHaveBeenCalled();
    expect(el.textContent).toContain(getMessages('en').booking.confirmed);
    expect(el.textContent).not.toContain('Taking you to');
    expect(continueLink(el)).toBeUndefined();
  });

  it('never follows a URL that is not https, whatever the booking write returned', async () => {
    for (const unsafe of ['javascript:alert(1)', 'http://example.com/thanks', 'data:text/html,hi']) {
      const el = await mount();
      await book(el, unsafe);
      expect(navigation.followRedirect).not.toHaveBeenCalled();
      expect(el.querySelector(`a[href="${unsafe}"]`)).toBeNull();
      expect(el.textContent).not.toContain('Taking you to');
      act(() => root?.unmount());
      container?.remove();
    }
  });
});
