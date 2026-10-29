// @vitest-environment jsdom
/**
 * The host's own tags hear the booking funnel on the booking page: the day and
 * the time picked as they happen, and the booking (Meta's `Schedule`, GTM's
 * `booking_scheduled`) once per booking, after the write confirmed it. With a
 * redirect after booking, the page leaves only after a short grace when a tag
 * was told (so its request is not cancelled), and at once otherwise.
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

type TagWindow = Window & { fbq?: (...args: unknown[]) => void; dataLayer?: unknown[] };
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
/** What the GTM loader leaves on the page: a dataLayer that starts with `gtm.js`. */
const withContainer = () => {
  (window as TagWindow).dataLayer = [{ 'gtm.start': 1, event: 'gtm.js' }];
};
const events = () => ((window as TagWindow).dataLayer ?? []).slice(1).map((e) => (e as { event: string }).event);
const pixelCalls = (fbq: ReturnType<typeof vi.fn>, method: string) => fbq.mock.calls.filter((c) => c[0] === method);

describe('the host’s tags hear of the booking', () => {
  it('Meta gets one Schedule and GTM one booking_scheduled, only once the booking landed', async () => {
    const fbq = vi.fn();
    (window as TagWindow).fbq = fbq;
    withContainer();
    const el = await mount();
    expect(fbq).not.toHaveBeenCalled();
    await book(el);
    expect(pixelCalls(fbq, 'track')).toEqual([
      ['track', 'Schedule', expect.objectContaining({ content_name: 'design-review', event_type: 'design-review' })],
    ]);
    expect(events().filter((e) => e === 'booking_scheduled')).toHaveLength(1);
  });

  it('hears the funnel in order: the day, the time, then the booking, with the event’s details and no invitee', async () => {
    const fbq = vi.fn();
    (window as TagWindow).fbq = fbq;
    withContainer();
    const el = await mount();
    await book(el);
    expect(events()).toEqual(['booking_date_selected', 'booking_time_selected', 'booking_scheduled']);
    expect(pixelCalls(fbq, 'trackCustom').map((c) => c[1])).toEqual(['BookingDateSelected', 'BookingTimeSelected']);
    const layer = (window as TagWindow).dataLayer!.slice(1) as { dcal: Record<string, unknown> }[];
    expect(layer[0]!.dcal).toMatchObject({ event_type: 'design-review', duration_minutes: fixture.eventType.lengthMinutes, is_team: false });
    expect(layer[1]!.dcal.start_time).toEqual(expect.any(String));
    expect(layer[2]!.dcal).toMatchObject({ booking_status: 'accepted', start_time: layer[1]!.dcal.start_time });
    const sent = JSON.stringify([fbq.mock.calls, layer]);
    for (const secret of ['Sam Visitor', 'sam@example.com', 'Example Co']) expect(sent).not.toContain(secret);
  });

  it('a pending request counts too', async () => {
    const fbq = vi.fn();
    (window as TagWindow).fbq = fbq;
    withContainer();
    const el = await mount();
    await book(el, undefined, 'pending');
    expect(pixelCalls(fbq, 'track')).toEqual([
      ['track', 'Schedule', expect.objectContaining({ content_name: 'design-review', event_type: 'design-review' })],
    ]);
    const last = (window as TagWindow).dataLayer!.at(-1) as { event: string; dcal: Record<string, unknown> };
    expect(last).toMatchObject({ event: 'booking_scheduled', dcal: { booking_status: 'pending' } });
  });

  it('a refused booking counts nothing', async () => {
    const fbq = vi.fn();
    (window as TagWindow).fbq = fbq;
    const el = await mount();
    actions.reserveAction.mockResolvedValueOnce({ ok: true, reservationUid: 'res_1', expiresAt: '2026-03-02T14:10:00.000Z' });
    await act(async () => el.querySelector<HTMLButtonElement>('.bp-slot')!.click());
    await act(async () => {
      type(el, 'input[name="name"]', 'Sam Visitor');
      type(el, 'input[name="email"]', 'sam@example.com');
      type(el, 'input[name="answer_company"]', 'Example Co');
    });
    actions.bookAction.mockResolvedValueOnce({ ok: false, status: 409, error: 'SLOT_TAKEN' });
    await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
    expect(actions.bookAction).toHaveBeenCalledTimes(1);
    // The steps it took were heard; a booking that did not land is no Schedule.
    expect(pixelCalls(fbq, 'track')).toEqual([]);
  });

  it('with a redirect after booking, the page leaves after the grace when a tag was told', async () => {
    (window as TagWindow).fbq = vi.fn();
    const el = await mount();
    await book(el, URL_OK);
    expect(navigation.followRedirect).not.toHaveBeenCalled();
    await wait(400);
    expect(navigation.followRedirect).toHaveBeenCalledTimes(1);
    expect(navigation.followRedirect).toHaveBeenCalledWith(URL_OK);
  });

  it('with a redirect after booking and no tag, the page leaves at once', async () => {
    const el = await mount();
    await book(el, URL_OK);
    expect(navigation.followRedirect).toHaveBeenCalledTimes(1);
  });
});
