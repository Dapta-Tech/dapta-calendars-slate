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
import { BASE_STYLE, NOW, TIME_ZONE, availability, booking } from '@/app/[accountCode]/__fixtures__/public-surface';

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

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('going back and re-picking the SAME time: the old pick\'s answer is given back, no error shown', async () => {
    const el = await mount();
    const first = deferred<ReturnType<typeof held>>();
    const second = deferred<{ ok: boolean; message?: string; reservationUid?: string; expiresAt?: string }>();
    actions.reserveAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await act(async () => slots(el)[0]!.click());
    await act(async () => backToTimes(el).click());
    await act(async () => slots(el)[0]!.click());
    // The re-pick does not ask for its hold while the old one is out.
    expect(actions.reserveAction).toHaveBeenCalledTimes(1);
    // The first pick's hold answers after the visitor came back to the time.
    await act(async () => {
      first.resolve(held('res_old'));
      await first.promise;
    });
    expect(formHold(el)).toBeNull();
    expect(actions.releaseAction).toHaveBeenCalledWith('res_old');
    // The old hold is given back BEFORE the new one is asked for, so the
    // server never sees the time as still held by the visitor's own old pick.
    expect(actions.reserveAction).toHaveBeenCalledTimes(2);
    expect(actions.releaseAction.mock.invocationCallOrder[0]!).toBeLessThan(
      actions.reserveAction.mock.invocationCallOrder[1]!,
    );
    await act(async () => {
      second.resolve(held('res_new'));
      await second.promise;
    });
    expect(formHold(el)).toBe('res_new');
    expect(el.textContent).not.toMatch(/not available to hold/i);
  });

  it('an old pick that answers with an error shows nothing', async () => {
    const el = await mount();
    const first = deferred<{ ok: boolean; message?: string }>();
    actions.reserveAction.mockReturnValueOnce(first.promise).mockResolvedValueOnce(held('res_b'));
    await act(async () => slots(el)[0]!.click());
    await act(async () => backToTimes(el).click());
    await act(async () => slots(el)[1]!.click());
    await act(async () => {
      first.resolve({ ok: false, message: 'That time is not available to hold.' });
      await first.promise;
    });
    expect(formHold(el)).toBe('res_b');
    expect(el.textContent).not.toMatch(/not available to hold/i);
  });

  it('the next pick waits for the release "back to times" sent, then holds', async () => {
    const el = await mount();
    actions.reserveAction.mockResolvedValueOnce(held('res_a'));
    await act(async () => slots(el)[0]!.click());
    expect(formHold(el)).toBe('res_a');
    const release = deferred<void>();
    actions.releaseAction.mockReturnValueOnce(release.promise);
    await act(async () => backToTimes(el).click());
    expect(actions.releaseAction).toHaveBeenCalledWith('res_a');
    actions.reserveAction.mockResolvedValueOnce(held('res_a2'));
    await act(async () => slots(el)[0]!.click());
    // Re-picking the time just let go: no hold is asked for while its release is in flight.
    expect(actions.reserveAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      release.resolve();
      await release.promise;
    });
    expect(actions.reserveAction).toHaveBeenCalledTimes(2);
    expect(formHold(el)).toBe('res_a2');
  });

  it('a hold that answers after the page is gone is given back', async () => {
    const el = await mount();
    const reserve = deferred<ReturnType<typeof held>>();
    actions.reserveAction.mockReturnValueOnce(reserve.promise);
    await act(async () => slots(el)[0]!.click());
    act(() => root?.unmount());
    root = null;
    await act(async () => {
      reserve.resolve(held('res_gone'));
      await reserve.promise;
    });
    expect(actions.releaseAction).toHaveBeenCalledWith('res_gone');
  });

  it('a hold that answers after the booking landed (a fast confirm) is given back', async () => {
    const el = await mount();
    const reserve = deferred<ReturnType<typeof held>>();
    actions.reserveAction.mockReturnValueOnce(reserve.promise);
    await act(async () => slots(el)[0]!.click());
    const at = el.querySelector<HTMLInputElement>('input[name="startUtc"]')!.value;
    actions.bookAction.mockResolvedValueOnce({
      ok: true,
      status: 201,
      booking: booking({ startUtc: at, endUtc: new Date(Date.parse(at) + 45 * 60_000).toISOString() }),
    });
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
    await act(async () => {
      reserve.resolve(held('res_after'));
      await reserve.promise;
    });
    expect(actions.releaseAction).toHaveBeenCalledWith('res_after');
  });

  it('a hold stored after a fast confirm went without it is given back once the booking lands; one it carried is not', async () => {
    const fill = async (el: HTMLElement) => {
      await act(async () => {
        type(el, 'input[name="name"]', 'Sam Visitor');
        type(el, 'input[name="email"]', 'sam@example.com');
        type(el, 'input[name="answer_company"]', 'Example Co');
      });
    };
    const landed = (el: HTMLElement) => {
      const at = el.querySelector<HTMLInputElement>('input[name="startUtc"]')!.value;
      return {
        ok: true,
        status: 201,
        booking: booking({ startUtc: at, endUtc: new Date(Date.parse(at) + 45 * 60_000).toISOString() }),
      };
    };

    // Submitted before the hold answered; the hold lands while the booking waits.
    let el = await mount();
    const reserve = deferred<ReturnType<typeof held>>();
    actions.reserveAction.mockReturnValueOnce(reserve.promise);
    await act(async () => slots(el)[0]!.click());
    await fill(el);
    const book = deferred<ReturnType<typeof landed>>();
    actions.bookAction.mockReturnValueOnce(book.promise);
    const answer = landed(el);
    await act(async () => {
      el.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await act(async () => {
      reserve.resolve(held('res_stored'));
      await reserve.promise;
    });
    expect(actions.releaseAction).not.toHaveBeenCalled();
    await act(async () => {
      book.resolve(answer);
      await book.promise;
    });
    expect(actions.releaseAction).toHaveBeenCalledWith('res_stored');

    // The ordinary path: the hold rode the form, the booking consumed it.
    act(() => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
    el = await mount();
    actions.reserveAction.mockResolvedValueOnce(held('res_carried'));
    await act(async () => slots(el)[0]!.click());
    expect(formHold(el)).toBe('res_carried');
    await fill(el);
    actions.bookAction.mockResolvedValueOnce(landed(el));
    await act(async () => {
      el.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    expect(el.querySelector('input[name="name"]')).toBeNull();
    expect(actions.releaseAction).not.toHaveBeenCalled();
  });
});
