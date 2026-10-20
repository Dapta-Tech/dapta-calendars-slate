// @vitest-environment jsdom
/**
 * The event editor's Location, on a TEAM event: one location applies to every
 * host, and the meeting link comes from the assigned host's own calendar. With
 * an online meeting chosen, the editor says so, and names the hosts who have no
 * destination calendar connected (their bookings would get no link). A personal
 * event keeps its own hint and warning.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessages } from '@slate/shared';
import type { Connection, EventType } from '@/lib/admin-api';

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

import { EventTypeForm, type TeamMemberOption } from './event-type-form';

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
});

const event = (over: Partial<EventType> = {}): EventType => ({
  id: 'et-1',
  memberId: null,
  teamId: 'team-1',
  slug: 'demo',
  title: 'Demo',
  description: null,
  lengthMinutes: 30,
  location: { kind: 'conferencing', detail: null },
  hidden: false,
  minimumBookingNotice: 120,
  beforeEventBuffer: 0,
  afterEventBuffer: 0,
  slotInterval: 30,
  schedulingType: 'round_robin',
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

const ANA: TeamMemberOption = {
  memberId: 'm-ana',
  displayName: 'Ana Ruiz',
  hasDestinationCalendar: true,
};
const CASEY: TeamMemberOption = {
  memberId: 'm-casey',
  displayName: 'Casey Morgan',
  hasDestinationCalendar: false,
};
const TAYLOR: TeamMemberOption = {
  memberId: 'm-taylor',
  displayName: 'Taylor Brooks',
  hasDestinationCalendar: false,
};

/** Async so the one-off links list, which loads on mount, settles inside act. */
async function mount(opts: {
  initial?: EventType;
  teamMembers?: TeamMemberOption[];
  connections?: Connection[];
  locale?: 'en' | 'es';
}) {
  const locale = opts.locale ?? 'en';
  const msgs = getMessages(locale);
  const team = !!opts.teamMembers;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <EventTypeForm
        initial={opts.initial ?? event()}
        messages={msgs.admin.eventTypes}
        locationLabels={msgs.location}
        scheduling={team ? msgs.scheduling : undefined}
        teamMembers={opts.teamMembers}
        connections={opts.connections}
        backHref="/admin/event-types"
        backLabel="Events"
        heading="Demo"
        locale={locale}
      />,
    ),
  );
  return container;
}

const en = getMessages('en').admin.eventTypes;
const es = getMessages('es').admin.eventTypes;
const warningFor = (m: typeof en, names: string) =>
  m.locationTeamNoDestinationWarning.replace('{names}', names);
/** The words before the names: present in the text if and only if the warning is. */
const warningLead = en.locationTeamNoDestinationWarning.split('{names}')[0]!;
const text = (el: HTMLElement) => el.textContent ?? '';

describe('team event, online meeting', () => {
  it('says the location applies to every host, and names the hosts with no calendar', async () => {
    // Out of order on purpose: the roster has no set order, the warning does.
    const el = await mount({ teamMembers: [TAYLOR, ANA, CASEY] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(en.locationConferencingHint);
    expect(text(el)).toContain(warningFor(en, 'Casey Morgan, Taylor Brooks'));
    // Ana has a calendar: never named.
    expect(text(el)).not.toContain(warningFor(en, 'Ana Ruiz'));
    // The personal warning, with its connect button, is not the team's.
    expect(text(el)).not.toContain(en.locationNoDestinationWarning);
  });

  it('in Spanish', async () => {
    const el = await mount({ teamMembers: [ANA, CASEY], locale: 'es' });
    expect(text(el)).toContain(es.locationTeamConferencingHint);
    expect(text(el)).toContain(warningFor(es, 'Casey Morgan'));
  });

  it('shows the helper but no warning when every host has a calendar', async () => {
    const el = await mount({ teamMembers: [ANA] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(warningLead);
  });

  it('warns about nobody when the API does not report calendars (an older API)', async () => {
    const el = await mount({ teamMembers: [{ memberId: 'm-old', displayName: 'Old Api' }] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(warningLead);
  });

  it('drops the helper and the warning once another kind is chosen', async () => {
    const el = await mount({ teamMembers: [ANA, CASEY] });
    const select = el.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('conferencing');
    act(() => {
      select.value = 'in_person';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(text(el)).not.toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(warningLead);
  });
});

describe('personal event, online meeting', () => {
  it('keeps the generic hint and its own warning, and none of the team copy', async () => {
    const el = await mount({
      initial: event({ teamId: null, memberId: 'm-ana' }),
      connections: [],
    });
    expect(text(el)).toContain(en.locationConferencingHint);
    expect(text(el)).toContain(en.locationNoDestinationWarning);
    expect(text(el)).not.toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(warningLead);
  });
});
