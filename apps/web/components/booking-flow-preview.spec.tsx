// @vitest-environment jsdom
/**
 * PREVIEW MODE (the event editor's eye button): the host clicks through the
 * real page, but nothing is held and nothing is booked. Harness shared with
 * `booking-flow-hold.spec.tsx`.
 *
 * (Original harness notes:) The hold the booking form carries. The booking write consumes whatever hold
 * the form posts, and a hold binds one host, event and time, so the form must
 * only ever carry the hold on the time it shows. A hold that answered after
 * the visitor had moved on used to be stored anyway: after "back to times" it
 * was never given back (the time stayed hidden from everyone for ten
 * minutes), and after picking another time it rode that time's form into a 410.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

async function mount() {
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
            previewNotice="Preview: nothing was booked."
          />
        </main>
      </BrandedShell>,
    );
  });
  return container;
}

const formHold = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>('input[name="reservationUid"]')?.value ?? null;
const slots = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.bp-slot')];

describe('preview mode', () => {
  it('picking a time holds nothing, and a valid submit books nothing and says so', async () => {
    const el = await mount();
    await act(async () => slots(el)[0]!.click());
    expect(actions.reserveAction).not.toHaveBeenCalled();
    expect(formHold(el)).toBeFalsy();
    // The form, with the event's questions, is there to see and fill.
    expect(el.querySelector('form.bp-form')).not.toBeNull();
    type(el, 'input[name="name"]', 'Sam Taylor');
    type(el, 'input[name="email"]', 'sam@example.com');
    for (const input of el.querySelectorAll<HTMLInputElement>('form.bp-form input[required]')) {
      if (!input.value && input.name !== 'name' && input.name !== 'email') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'x');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    await act(async () => el.querySelector<HTMLButtonElement>('form.bp-form button[type="submit"]')!.click());
    expect(actions.bookAction).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="bp-preview-notice"]')?.textContent).toBe('Preview: nothing was booked.');
  });
});
