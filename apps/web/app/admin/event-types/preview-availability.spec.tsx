// @vitest-environment jsdom
/**
 * The editor's previews (the eye button hands the unsaved draft to a new tab
 * that draws it as the booking page; each reminder previews the real email
 * the API would send) and the availability source (working hours, a saved schedule, or the event's own
 * custom hours edited as day → from → to rows).
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
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => <a {...rest}>{children}</a>,
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
  previewReminderAction: vi.fn(),
}));

import { previewReminderAction, saveEventTypeAction, type EventTypePayload } from './actions';
import { takeDraftPreview } from './draft-preview';
import { EventTypeForm } from './event-type-form';
import { dayKeyOf, daysOfKey, nextRow, rowsFromRules } from './sections/availability';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
  // The booking island and the zone picker measure themselves.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  vi.mocked(saveEventTypeAction).mockReset().mockResolvedValue({ ok: true });
  window.history.replaceState(null, '', '/admin/event-types/et-1');
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

const WORKING = {
  timeZone: 'America/Bogota',
  rules: [1, 2, 3, 4, 5].map((d) => ({ days: [d], startTime: '09:00', endTime: '17:00', date: null })),
};
const SCHEDULES = [
  { id: 'sched-default', name: 'Working hours', isDefault: true },
  { id: 'sched-evenings', name: 'Evenings', isDefault: false },
];

async function mount(
  initial: EventType | undefined,
  opts: { locale?: Locale; team?: boolean; schedules?: typeof SCHEDULES } = {},
) {
  const locale = opts.locale ?? 'en';
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
        scheduling={opts.team ? msgs.scheduling : undefined}
        teamMembers={opts.team ? [] : undefined}
        teamName={opts.team ? 'Sales' : undefined}
        backHref="/admin/event-types"
        backLabel="Events"
        heading={initial?.title ?? 'New event'}
        locale={locale}
        schedules={opts.schedules ?? SCHEDULES}
        workingHours={WORKING}
      />,
    ),
  );
  return container;
}

const m = getMessages('en').admin.eventTypes;
const a = m.editor.availability;
const byId = <T extends HTMLElement = HTMLInputElement>(el: HTMLElement, id: string) => el.querySelector<T>(`#${id}`);
const click = (b: HTMLElement) => act(async () => b.click());
async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const source = (el: HTMLElement, value: string) =>
  el.querySelector<HTMLInputElement>(`input[name="et-availability-source"][value="${value}"]`)!;
const rows = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLLIElement>('#et-hours li')].map((li) => {
    const sel = li.querySelector('select')!;
    const times = [...li.querySelectorAll('button[aria-haspopup]')].map((b) => b.textContent);
    return `${sel.selectedOptions[0]!.textContent} ${times.join('-')}`;
  });
const save = (el: HTMLElement) => click(el.querySelector<HTMLButtonElement>('button[type="submit"]')!);
const saved = () => vi.mocked(saveEventTypeAction).mock.lastCall?.[0] as EventTypePayload | undefined;

describe('preview booking page (eye button)', () => {
  it('opens a new tab with the unsaved draft, which the tab reads back', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const el = await mount(event({ bookingFields: [{ name: 'company', label: 'Company', type: 'text', required: true }] }));
    await typeInto(byId(el, 'et-title')!, 'Discovery call');
    await typeInto(el.querySelector<HTMLTextAreaElement>('textarea')!, 'Thirty minutes.');
    const eye = el.querySelector<HTMLButtonElement>('[data-testid="et-preview-page"]')!;
    expect(eye.getAttribute('aria-label')).toBe(m.editor.preview.eye);
    await click(eye);
    expect(open).toHaveBeenCalledTimes(1);
    const url = new URL(String(open.mock.calls[0]![0]), 'http://x');
    expect(url.pathname).toBe('/preview/event');
    expect(open.mock.calls[0]![1]).toBe('_blank');
    // The draft never rides in the URL.
    expect(url.search).not.toContain('Discovery');
    expect(takeDraftPreview(url.searchParams.get('k'))).toMatchObject({
      title: 'Discovery call',
      description: 'Thirty minutes.',
      lengthMinutes: 30,
      bookingFields: [{ name: 'company', label: 'Company' }],
    });
    open.mockRestore();
  });

  it('is on the create screen too', async () => {
    const el = await mount(undefined);
    expect(el.querySelector('[data-testid="et-preview-page"]')).not.toBeNull();
  });
});

describe('reminder email preview', () => {
  const reminders = [
    { id: 'r1', kind: 'reminder' as const, enabled: true, leadMinutes: 1440, subject: 'See you {{reminder_lead}}', body: null },
  ];

  it('renders the real email for the unsaved reminder, in a sandboxed frame', async () => {
    vi.mocked(previewReminderAction).mockResolvedValueOnce({
      ok: true,
      from: 'dCal <bookings@example.com>',
      to: 'Sam Taylor <sam@example.com>',
      subject: 'See you in 1 day(s)',
      html: '<table><tr><td>Discovery call</td></tr></table>',
    });
    const el = await mount(event({ title: 'Discovery call', reminders }));
    await click([...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === 'Reminders')!);
    await click(el.querySelector<HTMLButtonElement>('[data-testid="et-email-eye"]')!);
    expect(vi.mocked(previewReminderAction).mock.lastCall?.[0]).toMatchObject({
      kind: 'reminder',
      leadMinutes: 1440,
      subject: 'See you {{reminder_lead}}',
      body: null,
      title: 'Discovery call',
      lengthMinutes: 30,
    });
    expect(el.querySelector('[data-testid="et-email-eye"]')!.getAttribute('aria-label')).toBe(m.editor.preview.emailButton);
    expect(document.querySelector('[data-testid="et-email-subject"]')!.textContent).toBe('See you in 1 day(s)');
    const header = document.querySelector('[data-testid="et-email-preview"] dl')!.textContent;
    expect(header).toContain('dCal <bookings@example.com>');
    expect(header).toContain('Sam Taylor <sam@example.com>');
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="et-email-frame"]')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('Discovery call');
  });

  it('says so when the preview cannot be rendered', async () => {
    vi.mocked(previewReminderAction).mockResolvedValueOnce({ ok: false, message: 'down' });
    const el = await mount(event({ reminders }));
    await click(el.querySelector<HTMLButtonElement>('[data-testid="et-email-eye"]')!);
    expect(document.querySelector('[data-testid="et-email-preview"]')!.textContent).toContain(m.editor.preview.emailError);
  });
});

describe('availability source', () => {
  it('a new event starts on my working hours, shown read-only with a link to edit them', async () => {
    const el = await mount(undefined);
    expect(source(el, 'working').checked).toBe(true);
    expect(el.querySelector('[data-testid="et-working-hours"]')!.textContent).toContain(`${a.weekdays} · 09:00–17:00`);
    expect(el.querySelector('a[href="/admin/availability"]')!.textContent).toBe(a.editWorkingHours);
  });

  it('an event on a saved schedule opens on it, and saves it', async () => {
    const el = await mount(event({ scheduleId: 'sched-evenings' }));
    expect(source(el, 'saved').checked).toBe(true);
    await save(el);
    expect(saved()?.scheduleId).toBe('sched-evenings');
    expect(saved()).not.toHaveProperty('customHours');
  });

  it('a team event offers no custom hours and says whose hours apply', async () => {
    const el = await mount(event({ teamId: 'team-1', memberId: null, schedulingType: 'round_robin' }), { team: true });
    expect(el.querySelector('input[name="et-availability-source"][value="custom"]')).toBeNull();
    expect(el.textContent).toContain(a.team);
  });
});

describe('custom hours', () => {
  it('first opens prefilled from the working hours, in their time zone', async () => {
    const el = await mount(event());
    await click(source(el, 'custom'));
    expect(rows(el)).toEqual([`${a.weekdays} 09:00 AM-05:00 PM`]);
  });

  it('a preset saves as one row and reads back as that preset', async () => {
    const el = await mount(event());
    await click(source(el, 'custom'));
    await save(el);
    expect(saved()?.customHours).toEqual({
      timeZone: 'America/Bogota',
      ranges: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
    });
    expect(saved()).not.toHaveProperty('scheduleId');
    act(() => root?.unmount());
    container?.remove();
    const again = await mount(event({ customHours: saved()!.customHours! }));
    expect(source(again, 'custom').checked).toBe(true);
    expect(rows(again)).toEqual([`${a.weekdays} 09:00 AM-05:00 PM`]);
  });

  it('+ Add hours adds the next uncovered day at the last row’s times; delete removes a row', async () => {
    const el = await mount(event());
    await click(source(el, 'custom'));
    await click([...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === `+ ${a.addHours}`)!);
    expect(rows(el)).toEqual([`${a.weekdays} 09:00 AM-05:00 PM`, 'Saturday 09:00 AM-05:00 PM']);
    await click(el.querySelectorAll<HTMLButtonElement>(`#et-hours button[aria-label^="${a.remove}"]`)[1]!);
    expect(rows(el)).toHaveLength(1);
  });

  it('several ranges on one day are kept', async () => {
    const el = await mount(
      event({
        customHours: {
          timeZone: 'UTC',
          ranges: [
            { days: [1], start: '09:00', end: '12:00' },
            { days: [1], start: '14:00', end: '18:00' },
          ],
        },
      }),
    );
    await save(el);
    expect(saved()?.customHours?.ranges).toHaveLength(2);
  });

  it('refuses no rows, and an overlap made by a preset, beside the row', async () => {
    const el = await mount(event({ customHours: { timeZone: 'UTC', ranges: [{ days: [1], start: '09:00', end: '12:00' }] } }));
    await click(el.querySelector<HTMLButtonElement>(`#et-hours button[aria-label^="${a.remove}"]`)!);
    await save(el);
    expect(saveEventTypeAction).not.toHaveBeenCalled();
    expect(el.textContent).toContain(a.rangesRequired);
    expect(document.activeElement?.id).toBe('et-hours');

    await click([...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === `+ ${a.addHours}`)!);
    await click([...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === `+ ${a.addHours}`)!);
    await choose(byId<HTMLSelectElement>(el, 'et-hours-0-day')!, 'weekdays');
    await save(el);
    expect(saveEventTypeAction).not.toHaveBeenCalled();
    expect(el.textContent).toContain(a.overlap);
    expect(document.activeElement?.id).toBe('et-hours-1-day');
  });

  it('switching back to working hours deletes them on save', async () => {
    const el = await mount(event({ customHours: { timeZone: 'UTC', ranges: [{ days: [2], start: '10:00', end: '12:00' }] } }));
    await click(source(el, 'working'));
    await save(el);
    expect(saved()?.customHours).toBeNull();
    expect(saved()?.scheduleId).toBeNull();
  });
});

describe('custom hours helpers', () => {
  it('day keys round-trip presets, single days and other sets', () => {
    expect(dayKeyOf([1, 2, 3, 4, 5])).toBe('weekdays');
    expect(dayKeyOf([6, 0])).toBe('weekends');
    expect(dayKeyOf([0, 1, 2, 3, 4, 5, 6])).toBe('every');
    expect(dayKeyOf([3])).toBe('3');
    expect(daysOfKey(dayKeyOf([1, 3]))).toEqual([1, 3]);
  });

  it('working hours become rows: presets joined, other sets one row per day, overrides dropped', () => {
    expect(
      rowsFromRules([
        ...WORKING.rules,
        { days: [6], startTime: '10:00', endTime: '12:00', date: null },
        { days: [1, 3], startTime: '18:00', endTime: '20:00', date: null },
        { days: null, startTime: '09:00', endTime: '10:00', date: '2026-12-24' },
      ]),
    ).toEqual([
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
      { days: [1], start: '18:00', end: '20:00' },
      { days: [3], start: '18:00', end: '20:00' },
      { days: [6], start: '10:00', end: '12:00' },
    ]);
  });

  it('the next row is the first uncovered day, Monday first, at the last row’s times', () => {
    expect(nextRow([])).toEqual({ days: [1], start: '09:00', end: '17:00' });
    expect(nextRow([{ days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '12:00' }])).toEqual({
      days: [0],
      start: '08:00',
      end: '12:00',
    });
  });
});
