// @vitest-environment jsdom
/**
 * The editor's "Redirect after booking" field: it opens on the stored URL,
 * refuses anything but a full https address beside the field (after a blur or
 * a save attempt, never on the first keystroke) without sending the save, and
 * saves a trimmed URL or null for blank. Personal and team events alike, in
 * English and Spanish.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';

vi.mock('next/link', () => ({
  default: ({
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }),
}));
vi.mock('./actions', () => ({
  listOneOffLinksAction: vi.fn(async () => ({ ok: true, links: [] })),
  mintOneOffLinkAction: vi.fn(),
  revokeOneOffLinkAction: vi.fn(),
  saveEventTypeAction: vi.fn(),
  refreshCrmPropertiesAction: vi.fn(),
}));

import { saveEventTypeAction, type EventTypePayload } from './actions';
import { EventTypeForm } from './event-type-form';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.mocked(saveEventTypeAction).mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const event = (over: Partial<EventType> = {}): EventType => ({
  id: 'et-1',
  memberId: 'mem-1',
  teamId: null,
  slug: 'intro',
  title: 'Intro',
  description: null,
  lengthMinutes: 30,
  location: null,
  hidden: false,
  minimumBookingNotice: 120,
  beforeEventBuffer: 0,
  afterEventBuffer: 0,
  slotInterval: 30,
  schedulingType: null,
  requiresConfirmation: false,
  preventDuplicateBookings: false,
  seatsPerTimeSlot: null,
  bookingFields: [],
  reminders: [],
  hostMemberIds: [],
  hosts: [],
  scheduleId: null,
  conflictCalendarIds: [],
  destinationCalendarId: null,
  crmPropertyMappings: null,
  ...over,
});

async function mount(initial: EventType, locale: Locale = 'en', team = false) {
  const msgs = getMessages(locale);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <EventTypeForm
        initial={initial}
        messages={msgs.admin.eventTypes}
        locationLabels={msgs.location}
        scheduling={team ? msgs.scheduling : undefined}
        teamMembers={team ? [] : undefined}
        teamName={team ? 'Sales' : undefined}
        backHref="/admin/event-types"
        backLabel="Events"
        heading="Intro"
        locale={locale}
      />,
    ),
  );
  return container;
}

function field(el: HTMLElement, locale: Locale = 'en'): HTMLInputElement {
  const label = getMessages(locale).admin.eventTypes.successRedirect.label;
  const wrapper = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!;
  return wrapper.querySelector('input')!;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save(el: HTMLElement) {
  await act(async () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
}

const saved = () => vi.mocked(saveEventTypeAction).mock.lastCall?.[0] as EventTypePayload | undefined;

describe('Redirect after booking, in the event type editor', () => {
  it('opens on the stored URL and saves it as it is', async () => {
    const el = await mount(event({ successRedirectUrl: 'https://example.com/thanks' }));
    expect(field(el).value).toBe('https://example.com/thanks');
    await save(el);
    expect(saved()?.successRedirectUrl).toBe('https://example.com/thanks');
  });

  it('opens empty on an event without one, and saves null', async () => {
    const el = await mount(event());
    expect(field(el).value).toBe('');
    expect(field(el).getAttribute('placeholder')).toBe('https://example.com/thanks');
    await save(el);
    expect(saved()?.successRedirectUrl).toBeNull();
  });

  for (const locale of ['en', 'es'] as const) {
    const m = getMessages(locale).admin.eventTypes.successRedirect;

    it(`refuses anything but https beside the field and does not send the save (${locale})`, async () => {
      const el = await mount(event(), locale);
      const input = field(el, locale);
      await typeInto(input, 'http://example.com/thanks');
      // Not on the first keystroke: only after a blur or a save attempt.
      expect(el.textContent).not.toContain(m.invalid);
      await save(el);
      expect(saveEventTypeAction).not.toHaveBeenCalled();
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(m.invalid);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      // Focus goes to the field: it sits far below the Save button.
      expect(document.activeElement).toBe(input);
      // The hint stays: it is what says rescheduling never redirects.
      expect(el.textContent).toContain(m.hint);

      await typeInto(input, '  https://example.com/gracias  ');
      expect(el.textContent).not.toContain(m.invalid);
      await save(el);
      expect(saved()?.successRedirectUrl).toBe('https://example.com/gracias');
    });
  }

  it('shows the error on blur, and clears to null when emptied', async () => {
    const el = await mount(event({ successRedirectUrl: 'https://example.com/thanks' }));
    const input = field(el);
    await typeInto(input, 'javascript:alert(1)');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(el.textContent).toContain(getMessages('en').admin.eventTypes.successRedirect.invalid);
    await typeInto(input, '   ');
    await save(el);
    expect(saved()?.successRedirectUrl).toBeNull();
  });

  it('is offered on team events too, and travels on their save', async () => {
    const el = await mount(
      event({ memberId: null, teamId: 'team-1', schedulingType: 'round_robin', successRedirectUrl: 'https://example.com/team' }),
      'en',
      true,
    );
    expect(field(el).value).toBe('https://example.com/team');
    await save(el);
    expect(saved()?.successRedirectUrl).toBe('https://example.com/team');
  });
});
