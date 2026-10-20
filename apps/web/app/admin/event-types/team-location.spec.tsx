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
type Copy = typeof en;
const one = (m: Copy, names: string) => m.locationTeamNoDestinationOne.replace('{names}', names);
const many = (m: Copy, names: string) => m.locationTeamNoDestinationMany.replace('{names}', names);
const text = (el: HTMLElement) => el.textContent ?? '';
/** The team warning's own paragraph, or null when there is none. */
const warning = (el: HTMLElement, m: Copy = en) => {
  const lead = m.locationTeamNoDestinationOne.split('{names}')[0]!;
  return (
    [...el.querySelectorAll('p')]
      .map((p) => p.textContent ?? '')
      .find((t) => t.startsWith(lead) || t === m.locationTeamNoDestinationAll) ?? null
  );
};
const fixedHost = (memberId: string) => ({ memberId, priority: 0, weight: 100, isFixed: true });

describe('team event, round robin, online meeting', () => {
  it('says the location applies to every host, and names the hosts with no calendar', async () => {
    // Out of order on purpose: the roster has no set order, the warning does.
    const el = await mount({ teamMembers: [TAYLOR, ANA, CASEY] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(text(el)).not.toContain(en.locationConferencingHint);
    expect(warning(el)).toBe(many(en, 'Casey Morgan and Taylor Brooks'));
    // Ana has a calendar: never named.
    expect(warning(el)).not.toContain('Ana Ruiz');
    // The personal warning, with its connect button, is not the team's.
    expect(text(el)).not.toContain(en.locationNoDestinationWarning);
  });

  it('in Spanish', async () => {
    const el = await mount({ teamMembers: [ANA, TAYLOR, CASEY], locale: 'es' });
    expect(text(el)).toContain(es.locationTeamConferencingHint);
    expect(text(el)).not.toContain(es.locationConferencingHint);
    expect(warning(el, es)).toBe(many(es, 'Casey Morgan y Taylor Brooks'));
  });

  it('says it of one host in the singular', async () => {
    const el = await mount({ teamMembers: [ANA, CASEY] });
    expect(warning(el)).toBe(one(en, 'Casey Morgan'));
  });

  it('names a host by email, then by id, when they have no display name', async () => {
    const el = await mount({
      teamMembers: [
        {
          memberId: 'm-mail',
          displayName: null,
          email: 'mail@example.test',
          hasDestinationCalendar: false,
        },
        { memberId: 'm-bare', displayName: null, email: null, hasDestinationCalendar: false },
      ],
    });
    expect(warning(el)).toBe(many(en, 'm-bare and mail@example.test'));
  });

  it('shows the helper but no warning when every host has a calendar', async () => {
    const el = await mount({ teamMembers: [ANA] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(warning(el)).toBeNull();
  });

  it('warns about nobody when the API does not report calendars (an older API)', async () => {
    const el = await mount({ teamMembers: [{ memberId: 'm-old', displayName: 'Old Api' }] });
    expect(text(el)).toContain(en.locationTeamConferencingHint);
    expect(warning(el)).toBeNull();
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
    expect(warning(el)).toBeNull();
  });
});

describe('team event, collective: every host is on every booking', () => {
  const collective = event({ schedulingType: 'collective' });

  it('one host with a calendar is enough: no warning', async () => {
    const el = await mount({ initial: collective, teamMembers: [ANA, CASEY] });
    expect(text(el)).toContain(en.locationTeamSharedConferencingHint);
    expect(text(el)).not.toContain(en.locationTeamConferencingHint);
    expect(warning(el)).toBeNull();
  });

  it('warns when no host has one', async () => {
    const el = await mount({ initial: collective, teamMembers: [CASEY, TAYLOR] });
    expect(warning(el)).toBe(en.locationTeamNoDestinationAll);
  });
});

describe('team event, fixed round robin: every fixed host is on every booking', () => {
  it('a fixed host with a calendar is enough: no warning', async () => {
    const el = await mount({
      initial: event({ schedulingType: 'fixed_round_robin', hosts: [fixedHost('m-ana')] }),
      teamMembers: [ANA, CASEY],
    });
    expect(text(el)).toContain(en.locationTeamSharedConferencingHint);
    expect(warning(el)).toBeNull();
  });

  it('without one, names the rotating hosts with no calendar, never the fixed ones', async () => {
    const el = await mount({
      initial: event({ schedulingType: 'fixed_round_robin', hosts: [fixedHost('m-casey')] }),
      teamMembers: [ANA, CASEY, TAYLOR],
    });
    expect(warning(el)).toBe(one(en, 'Taylor Brooks'));
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
    expect(warning(el)).toBeNull();
  });
});
