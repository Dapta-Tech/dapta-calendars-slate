// @vitest-environment jsdom
/**
 * The hold the booking form carries. The booking write consumes whatever hold
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

/** A server action the test answers by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const held = (uid: string) => ({ ok: true, reservationUid: uid, expiresAt: '2026-03-02T14:10:00.000Z' });

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
const backToTimes = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.bp-chosen .bp-back')!;

describe('the booking form carries only the hold on the time it shows', () => {
  it('a hold that answers after "back to times" is given straight back, never stored', async () => {
    const el = await mount();
    const reserve = deferred<ReturnType<typeof held>>();
    actions.reserveAction.mockReturnValueOnce(reserve.promise);
    await act(async () => slots(el)[0]!.click());
    await act(async () => backToTimes(el).click());
    await act(async () => {
      reserve.resolve(held('res_late'));
      await reserve.promise;
    });
    expect(actions.releaseAction).toHaveBeenCalledWith('res_late');
    // Picking again starts clean: no hold rides in from the abandoned pick.
    actions.reserveAction.mockResolvedValueOnce(held('res_fresh'));
    await act(async () => slots(el)[1]!.click());
    expect(formHold(el)).toBe('res_fresh');
  });

  it('a hold for a time already left never reaches the form for the next one', async () => {
    const el = await mount();
    const first = deferred<ReturnType<typeof held>>();
    const second = deferred<ReturnType<typeof held>>();
    actions.reserveAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    // One time, back, another, all before either hold has answered.
    await act(async () => slots(el)[0]!.click());
    await act(async () => backToTimes(el).click());
    await act(async () => slots(el)[1]!.click());
    // The first time's hold lands while the form shows the second time.
    await act(async () => {
      first.resolve(held('res_first'));
      await first.promise;
    });
    expect(formHold(el)).toBeNull();
    expect(actions.releaseAction).toHaveBeenCalledWith('res_first');
    await act(async () => {
      second.resolve(held('res_second'));
      await second.promise;
    });
    expect(formHold(el)).toBe('res_second');
    expect(actions.releaseAction).not.toHaveBeenCalledWith('res_second');
  });
});
