// @vitest-environment jsdom
/**
 * What the booking page says when something on our side gets in the way: a
 * busy service (429), a calendar that cannot be read, a booking that did not go
 * through. In the visitor's language, never the API's English, and a failed
 * submit is never silent (it used to re-render the form with no word at all).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getMessages } from '@slate/shared';

const actions = vi.hoisted(() => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => actions);

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
  vi.clearAllMocks();
});

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount(locale: 'en' | 'es' = 'en') {
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
            locale={locale}
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

const slots = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.bp-slot')];
const alerts = (el: HTMLElement) => [...el.querySelectorAll('[role="alert"]')].map((n) => n.textContent);

async function pickAndFill(el: HTMLElement) {
  actions.reserveAction.mockResolvedValueOnce({ ok: true, reservationUid: 'res_1', expiresAt: '2026-03-02T14:10:00.000Z' });
  await act(async () => slots(el)[0]!.click());
  await act(async () => {
    type(el, 'input[name="name"]', 'Sam Visitor');
    type(el, 'input[name="email"]', 'sam@example.com');
    type(el, 'input[name="answer_company"]', 'Example Co');
  });
}

describe('booking page trouble states', () => {
  for (const locale of ['en', 'es'] as const) {
    const copy = getMessages(locale).trouble;

    it(`a hold refused because the service is busy says so, and that the time can still be booked (${locale})`, async () => {
      const el = await mount(locale);
      actions.reserveAction.mockResolvedValueOnce({
        ok: false,
        status: 429,
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down.',
      });
      await act(async () => slots(el)[0]!.click());
      expect(el.textContent).toContain(copy.holdBusy);
      expect(el.textContent).not.toContain('Please slow down');
      // The form is still there: booking can go ahead without the hold.
      expect(el.querySelector('input[name="name"]')).not.toBeNull();
    });

    it(`a booking refused as busy keeps every field and says to press Confirm again (${locale})`, async () => {
      const el = await mount(locale);
      await pickAndFill(el);
      actions.bookAction.mockResolvedValueOnce({ ok: false, status: 429, error: 'RATE_LIMITED', retryAfterMs: 2000 });
      await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
      expect(alerts(el)).toContain(copy.bookBusy);
      expect(el.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Sam Visitor');
      expect(el.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe('sam@example.com');
      // Confirm is the retry, and it goes again.
      actions.bookAction.mockResolvedValueOnce({ ok: false, status: 500, error: 'ERROR' });
      await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
      expect(actions.bookAction).toHaveBeenCalledTimes(2);
      expect(alerts(el)).toContain(copy.bookFailed);
    });
  }

  it('a hold refused because the calendar could not be read is not called a taken time', async () => {
    const el = await mount();
    actions.reserveAction.mockResolvedValueOnce({ ok: false, status: 409, error: 'CALENDAR_UNAVAILABLE' });
    await act(async () => slots(el)[0]!.click());
    expect(el.textContent).toContain(getMessages('en').trouble.holdUnconfirmed);
  });

  it('a booking refused for an unreadable calendar keeps its own card: nothing was booked, try again', async () => {
    const el = await mount();
    await pickAndFill(el);
    actions.bookAction.mockResolvedValueOnce({ ok: false, status: 409, error: 'CALENDAR_UNAVAILABLE' });
    await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
    const m = getMessages('en').booking;
    expect(el.textContent).toContain(m.calendarUnavailableTitle);
    expect(el.textContent).toContain(m.calendarUnavailableBody);
  });
});
