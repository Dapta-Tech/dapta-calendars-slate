// @vitest-environment jsdom
/**
 * The form a visitor meets when the page that sent them here already knew who
 * they are: the three attendee fields and every custom question start filled,
 * and a prefilled booking carries those values through unchanged.
 *
 * The three promises these pin, in order of what breaks without them:
 *
 *   - a prefilled field is a STARTING value, not a locked one: it is editable,
 *     and what the visitor types instead is what gets booked;
 *   - the custom questions fill even though the island does not know them on
 *     the first paint (they arrive with the first availability read), and
 *     filling them never overwrites what the visitor has already typed;
 *   - a key naming a question this event type does not ask changes nothing,
 *     so one address can be reused across event types.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BookingPrefill } from '@slate/types';

const actions = vi.hoisted(() => ({
  bookAction: vi.fn(),
  reserveAction: vi.fn(),
  releaseAction: vi.fn(),
  meetingLinkAction: vi.fn(async () => null),
}));
vi.mock('@/app/[accountCode]/[handle]/[slug]/actions', () => actions);

import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import type { AvailabilityChunk } from '@/lib/availability-source';
import { BASE_STYLE, NOW, TIME_ZONE, availability, booking } from '@/app/[accountCode]/__fixtures__/public-surface';

const fixture = availability();
const FIRST = { from: NOW, to: '2026-04-01T04:00:00.000Z' };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Later months ride the same-origin route; nothing here needs them.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, slots: [] }) })));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  actions.bookAction.mockReset();
  actions.reserveAction.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The whole event up front (the one-off link page's shape): fields known on the first paint. */
async function mount(prefill: BookingPrefill | null) {
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
            locale="en"
            eventTitle={fixture.eventType.title}
            lengthMinutes={fixture.eventType.lengthMinutes}
            hostName="Riley Chen"
            avatarUrl={null}
            location={fixture.eventType.location}
            nowUtc={NOW}
            showBranding
            prefill={prefill}
          />
        </main>
      </BrandedShell>,
    );
  });
  return container;
}

/** The public event page's shape: the questions arrive with the first read. */
async function mountProgressive(prefill: BookingPrefill | null) {
  let resolve!: (c: AvailabilityChunk) => void;
  const initial = new Promise<AvailabilityChunk>((r) => (resolve = r));
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
            availability={{
              initial,
              window: FIRST,
              source: { kind: 'personal', accountCode: 'northwind', owner: 'riley-chen', slug: 'design-review' },
            }}
            initialTimeZone={TIME_ZONE}
            locale="en"
            eventTitle={fixture.eventType.title}
            lengthMinutes={fixture.eventType.lengthMinutes}
            hostName="Riley Chen"
            avatarUrl={null}
            location={fixture.eventType.location}
            nowUtc={NOW}
            showBranding
            prefill={prefill}
          />
        </main>
      </BrandedShell>,
    );
  });
  const land = async () => {
    await act(async () => {
      resolve({ ok: true, slots: fixture.slots, bookingFields: fixture.eventType.bookingFields });
      await initial;
    });
  };
  return { el: container, land };
}

/** Open the intake form by picking the first time. */
async function pickTime(el: HTMLElement) {
  actions.reserveAction.mockResolvedValueOnce({
    ok: true,
    reservationUid: 'res_1',
    expiresAt: '2026-03-02T14:10:00.000Z',
  });
  await act(async () => el.querySelector<HTMLButtonElement>('.bp-slot')!.click());
}

const valueOf = (el: HTMLElement, selector: string) =>
  el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!.value;

/** Confirm, and read back what the booking write was actually handed. */
async function confirm(el: HTMLElement) {
  const at = el.querySelector<HTMLInputElement>('input[name="startUtc"]')!.value;
  actions.bookAction.mockResolvedValueOnce({
    ok: true,
    status: 201,
    booking: booking({ startUtc: at, endUtc: new Date(Date.parse(at) + 45 * 60_000).toISOString() }),
  });
  await act(async () => el.querySelector<HTMLFormElement>('form')!.requestSubmit());
  const form = actions.bookAction.mock.calls.at(-1)?.[1] as FormData | undefined;
  return Object.fromEntries([...(form?.entries() ?? [])].map(([k, v]) => [k, String(v)]));
}

const PREFILL: BookingPrefill = {
  name: 'Sam Visitor',
  email: 'sam@example.com',
  notes: 'Came from the form',
  answers: { company: 'Example Co', topic: 'The new onboarding' },
};

describe('the intake form starts from the prefill', () => {
  it('fills the attendee fields and every custom question', async () => {
    const el = await mount(PREFILL);
    await pickTime(el);
    expect(valueOf(el, 'input[name="name"]')).toBe('Sam Visitor');
    expect(valueOf(el, 'input[name="email"]')).toBe('sam@example.com');
    expect(valueOf(el, 'textarea[name="notes"]')).toBe('Came from the form');
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('Example Co');
    expect(valueOf(el, 'textarea[name="answer_topic"]')).toBe('The new onboarding');
  });

  it('books those values when the visitor only picks a time', async () => {
    const el = await mount(PREFILL);
    await pickTime(el);
    const sent = await confirm(el);
    expect(sent.name).toBe('Sam Visitor');
    expect(sent.email).toBe('sam@example.com');
    expect(sent.notes).toBe('Came from the form');
    expect(sent.answer_company).toBe('Example Co');
  });

  it('leaves every prefilled field editable, and books what the visitor typed instead', async () => {
    const el = await mount(PREFILL);
    await pickTime(el);
    for (const selector of ['input[name="name"]', 'input[name="email"]', 'input[name="answer_company"]']) {
      expect(el.querySelector<HTMLInputElement>(selector)!.readOnly).toBe(false);
      expect(el.querySelector<HTMLInputElement>(selector)!.disabled).toBe(false);
    }
    await act(async () => {
      type(el, 'input[name="email"]', 'other@example.com');
      type(el, 'input[name="answer_company"]', 'Another Co');
    });
    const sent = await confirm(el);
    expect(sent.email).toBe('other@example.com');
    expect(sent.answer_company).toBe('Another Co');
  });

  it('keeps a field the visitor cleared empty, rather than filling it again', async () => {
    const el = await mount(PREFILL);
    await pickTime(el);
    await act(async () => type(el, 'input[name="answer_company"]', ''));
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('');
    // And a prefill does not weaken the question's own required flag: with it
    // cleared there is nothing to book, so the submit never leaves the page.
    await confirm(el);
    expect(actions.bookAction).not.toHaveBeenCalled();
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('');
  });

  it('changes nothing for a question this event type does not ask', async () => {
    const el = await mount({ answers: { company: 'Example Co', not_a_field: 'x' } });
    await pickTime(el);
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('Example Co');
    expect(el.querySelector('[name="answer_not_a_field"]')).toBeNull();
    const sent = await confirm(el);
    expect(sent.not_a_field).toBeUndefined();
    expect(sent.answer_not_a_field).toBeUndefined();
  });

  it('shows an empty form without a prefill, as it always did', async () => {
    const el = await mount(null);
    await pickTime(el);
    expect(valueOf(el, 'input[name="name"]')).toBe('');
    expect(valueOf(el, 'input[name="email"]')).toBe('');
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('');
  });

  it('does not flag a prefilled field as wrong before the visitor touches it', async () => {
    const el = await mount({ email: 'sam@' });
    await pickTime(el);
    expect(el.querySelector('.bp-error')).toBeNull();
    expect(valueOf(el, 'input[name="email"]')).toBe('sam@');
  });
});

describe('the custom questions fill once the page knows them', () => {
  it('fills them when they arrive with the first availability read', async () => {
    const { el, land } = await mountProgressive(PREFILL);
    await land();
    await pickTime(el);
    expect(valueOf(el, 'input[name="answer_company"]')).toBe('Example Co');
    expect(valueOf(el, 'textarea[name="answer_topic"]')).toBe('The new onboarding');
  });

  it('does not reset the attendee fields when the read lands', async () => {
    // The attendee values are seeded before any read, and the arriving fields
    // are what triggers the answers effect. If that effect replaced the state
    // object wholesale it would wipe them, which is exactly the regression the
    // "same object when nothing applied" rule guards against.
    const { el, land } = await mountProgressive(PREFILL);
    await land();
    await pickTime(el);
    expect(valueOf(el, 'input[name="name"]')).toBe('Sam Visitor');
    expect(valueOf(el, 'input[name="email"]')).toBe('sam@example.com');
    expect(valueOf(el, 'textarea[name="notes"]')).toBe('Came from the form');
  });
});
