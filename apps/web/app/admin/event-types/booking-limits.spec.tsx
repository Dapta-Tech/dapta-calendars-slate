// @vitest-environment jsdom
/**
 * Booking limits in the event type editor: four numbers under Advanced
 * settings (bookings and minutes, per day and per week). They open on the
 * stored values, empty for no limit; an out-of-range value is refused beside
 * its field without sending the save; the save carries numbers, or null when
 * emptied. Personal and team events, in English and Spanish.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';

vi.mock('next/link', () => ({
  default: ({ children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }) }));
vi.mock('./actions', () => ({
  listOneOffLinksAction: vi.fn(async () => ({ ok: true, links: [] })),
  mintOneOffLinkAction: vi.fn(),
  revokeOneOffLinkAction: vi.fn(),
  saveEventTypeAction: vi.fn(),
  refreshCrmPropertiesAction: vi.fn(),
}));

import { saveEventTypeAction, type EventTypePayload } from './actions';
import { EventTypeForm } from './event-type-form';

const IDS = {
  maxBookingsPerDay: 'et-max-bookings-per-day',
  maxBookingsPerWeek: 'et-max-bookings-per-week',
  maxMinutesPerDay: 'et-max-minutes-per-day',
  maxMinutesPerWeek: 'et-max-minutes-per-week',
} as const;

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
  root = container = null;
});

const event = (over: Partial<EventType> = {}): EventType => ({
  id: 'et-1', memberId: 'mem-1', teamId: null, slug: 'intro', title: 'Intro', description: null, lengthMinutes: 30,
  location: null, hidden: false, minimumBookingNotice: 120, beforeEventBuffer: 0, afterEventBuffer: 0, slotInterval: 30,
  schedulingType: null, requiresConfirmation: false, preventDuplicateBookings: false, seatsPerTimeSlot: null,
  bookingFields: [], reminders: [], hostMemberIds: [], hosts: [], scheduleId: null, conflictCalendarIds: [],
  destinationCalendarId: null, crmPropertyMappings: null, ...over,
});

async function mount(initial: EventType, locale: Locale = 'en', team = false) {
  const msgs = getMessages(locale);
  container = document.body.appendChild(document.createElement('div'));
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
const input = (key: keyof typeof IDS) => document.getElementById(IDS[key]) as HTMLInputElement;
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const save = (el: HTMLElement) => act(async () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
const saved = () => vi.mocked(saveEventTypeAction).mock.lastCall?.[0] as EventTypePayload | undefined;

describe('Booking limits, in the event type editor', () => {
  it('opens on the stored limits, saves them, and saves null for one emptied', async () => {
    const el = await mount(event({ maxBookingsPerDay: 4, maxMinutesPerWeek: 600 }));
    expect([input('maxBookingsPerDay').value, input('maxBookingsPerWeek').value, input('maxMinutesPerWeek').value]).toEqual(['4', '', '600']);
    await typeInto(input('maxMinutesPerWeek'), '');
    await typeInto(input('maxBookingsPerWeek'), '12');
    await save(el);
    expect(saved()).toMatchObject({ maxBookingsPerDay: 4, maxBookingsPerWeek: 12, maxMinutesPerDay: null, maxMinutesPerWeek: null });
  });

  for (const locale of ['en', 'es'] as const) {
    const m = getMessages(locale).admin.eventTypes.bookingLimits;
    it(`refuses 0, more than 1440 a day, and fewer minutes than the event lasts, beside the field, without saving (${locale})`, async () => {
      const el = await mount(event(), locale);
      expect(el.textContent).toContain(m.title);
      expect(input('maxBookingsPerDay').getAttribute('placeholder')).toBe(m.placeholder);
      for (const [key, bad, max] of [['maxBookingsPerDay', '0', '1440'], ['maxMinutesPerDay', '1441', '1440']] as const) {
        await typeInto(input(key), bad);
        await save(el);
        expect(saveEventTypeAction).not.toHaveBeenCalled();
        expect(document.getElementById(`${IDS[key]}-error`)?.textContent).toBe(m.invalid.replace('{max}', max));
        expect(document.activeElement).toBe(input(key));
        await typeInto(input(key), '');
      }
      // Fewer minutes a day than the event lasts (30) would close every day.
      await typeInto(input('maxMinutesPerDay'), '15');
      await save(el);
      expect(saveEventTypeAction).not.toHaveBeenCalled();
      expect(document.getElementById(`${IDS.maxMinutesPerDay}-error`)?.textContent).toBe(m.belowLength.replace('{min}', '30'));
      await typeInto(input('maxMinutesPerDay'), '');
      await save(el);
      expect(saved()?.maxBookingsPerDay).toBeNull();
    });
  }

  it('is offered on team events too, and travels on their save', async () => {
    const el = await mount(event({ memberId: null, teamId: 'team-1', schedulingType: 'round_robin', maxBookingsPerWeek: 20 }), 'en', true);
    expect(input('maxBookingsPerWeek').value).toBe('20');
    await save(el);
    expect(saved()?.maxBookingsPerWeek).toBe(20);
  });
});
