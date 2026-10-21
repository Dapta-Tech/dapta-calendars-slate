// @vitest-environment jsdom
/**
 * Where a person editing an event finds their team: a personal event's card
 * pointing at team events (one link per team, or "Create a team" when there is
 * none), and a team event's line saying every member hosts it, with the way to
 * the team page. Then a round robin host's priority: five levels stored as
 * -2..2, Medium for 0 and for no value, and a value set through the API
 * outside the levels kept as it is until someone picks a level. In English and
 * Spanish.
 */
import { act, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';

// No app router is mounted here: a plain anchor.
vi.mock('next/link', () => ({
  default: ({
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// The editor's server actions: the save is what these specs read.
vi.mock('./actions', () => ({
  saveEventTypeAction: vi.fn(),
  listOneOffLinksAction: vi.fn(),
  mintOneOffLinkAction: vi.fn(),
  revokeOneOffLinkAction: vi.fn(),
  refreshCrmPropertiesAction: vi.fn(),
}));

import { listOneOffLinksAction, saveEventTypeAction, type EventTypePayload } from './actions';
import { EventTypeForm } from './event-type-form';
import { HostPrioritySelect, HostReadiness, PersonalHostsCard, TeamHostsNote } from './team-hosts';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout engine; the Select scrolls its active row into view.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

const links = (el: HTMLElement) =>
  [...el.querySelectorAll('a')].map((a) => ({
    text: a.textContent,
    href: a.getAttribute('href'),
  }));

const TEAMS = [
  { id: 'team-1', name: 'Sales' },
  { id: 'team-2', name: 'Ventas LatAm' },
];

describe('PersonalHostsCard', () => {
  const card = (locale: Locale, teams = TEAMS, canManageTeams = true) => {
    const m = getMessages(locale).admin.eventTypes;
    return mount(
      <PersonalHostsCard
        teams={teams}
        title={m.hostsTitle}
        canManageTeams={canManageTeams}
        m={m.teamHosts}
      />,
    );
  };

  it('says a personal event has one host and offers a team event on each team', () => {
    const el = card('en');
    expect(el.textContent).toContain('Hosts');
    expect(el.textContent).toContain(
      'A personal event has one host. To share bookings with your team (round-robin or collective), create a team event.',
    );
    expect(links(el)).toEqual([
      { text: 'New event for Sales', href: '/admin/event-types/new?teamId=team-1' },
      { text: 'New event for Ventas LatAm', href: '/admin/event-types/new?teamId=team-2' },
    ]);
  });

  it('with no team yet, the one way forward is to create one', () => {
    const el = card('en', []);
    expect(links(el)).toEqual([{ text: 'Create a team', href: '/admin/teams/new' }]);
  });

  it('a plain member reads the explanation without links the API would refuse', () => {
    for (const teams of [TEAMS, []]) {
      const el = card('en', teams, false);
      expect(el.textContent).toContain('A personal event has one host.');
      expect(links(el)).toEqual([]);
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it('a long team name truncates inside its button and keeps the full name in the title', () => {
    const name = 'Customer Success and Renewals for Latin America';
    const el = card('en', [{ id: 'team-3', name }]);
    const link = el.querySelector('a')!;
    expect(link.getAttribute('title')).toBe(`New event for ${name}`);
    expect(link.className).toContain('max-w-full');
    expect(link.querySelector('span.truncate')?.textContent).toBe(`New event for ${name}`);
  });

  it('in Spanish', () => {
    const el = card('es');
    expect(el.textContent).toContain('Anfitriones');
    expect(el.textContent).toContain(
      'Un evento personal tiene un solo anfitrión. Para compartir reservas con tu equipo (por turnos o colectiva), crea un evento de equipo.',
    );
    expect(links(el).map((l) => l.text)).toEqual([
      'Nuevo evento para Sales',
      'Nuevo evento para Ventas LatAm',
    ]);
    expect(links(card('es', [])).map((l) => l.text)).toEqual(['Crear un equipo']);
  });
});

describe('TeamHostsNote', () => {
  const note = (locale: Locale, canManageTeams = true) =>
    mount(
      <TeamHostsNote
        teamId="team-1"
        teamName="Sales"
        canManageTeams={canManageTeams}
        m={getMessages(locale).admin.eventTypes.teamHosts}
      />,
    );

  it('names the team as the hosts and links to where its members are managed', () => {
    const el = note('en');
    expect(el.textContent).toBe(
      'Every member of Sales hosts this event once you save it. Add or remove members on the team page, then save this event.',
    );
    expect(links(el)).toEqual([
      { text: 'Add or remove members on the team page, then save this event.', href: '/admin/teams/team-1' },
    ]);
  });

  it('a plain member reads who hosts it, without the roster link', () => {
    const el = note('en', false);
    expect(el.textContent).toBe('Every member of Sales hosts this event once you save it.');
    expect(links(el)).toEqual([]);
  });

  it('in Spanish', () => {
    const el = note('es');
    expect(el.textContent).toBe(
      'Todos los miembros de Sales quedan como anfitriones de este evento al guardarlo. Agrega o quita miembros en la página del equipo y luego guarda este evento.',
    );
    expect(links(el)[0]?.href).toBe('/admin/teams/team-1');
  });
});

/** The priority picker's trigger for a host, by its accessible name. */
const priorityOf = (el: HTMLElement, name: string) =>
  el.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

/** Open a Select and pick the row with this label. */
function pick(el: HTMLElement, trigger: string, label: string) {
  act(() => priorityOf(el, trigger)!.click());
  const row = [...el.querySelectorAll<HTMLButtonElement>('[role="option"] button')].find(
    (b) => b.textContent === label,
  );
  if (!row) throw new Error(`no option "${label}"`);
  act(() => row.click());
}

const optionLabels = (el: HTMLElement) =>
  [...el.querySelectorAll('[role="option"]')].map((o) => ({
    label: o.textContent,
    disabled: o.getAttribute('aria-disabled') === 'true',
  }));

describe('HostPrioritySelect', () => {
  const select = (value: number | null, locale: Locale = 'en') => {
    const onChange = vi.fn();
    const el = mount(
      <HostPrioritySelect
        hostName="Jordan Lee"
        value={value}
        onChange={onChange}
        m={getMessages(locale).admin.eventTypes}
        locale={locale}
      />,
    );
    return { el, onChange };
  };

  it('reads Medium for 0 and for no value, and offers the five levels in order', () => {
    expect(priorityOf(select(0).el, 'Jordan Lee: Priority')!.textContent).toBe('Medium');
    act(() => root?.unmount());
    const { el } = select(null);
    const trigger = priorityOf(el, 'Jordan Lee: Priority')!;
    expect(trigger.textContent).toBe('Medium');
    act(() => trigger.click());
    expect(optionLabels(el)).toEqual(
      ['Lowest', 'Low', 'Medium', 'High', 'Highest'].map((label) => ({ label, disabled: false })),
    );
  });

  it('picks each level as -2..2', () => {
    const { el, onChange } = select(0);
    const levels: Array<[string, number]> = [
      ['Lowest', -2],
      ['Low', -1],
      ['Medium', 0],
      ['High', 1],
      ['Highest', 2],
    ];
    for (const [label, value] of levels) {
      pick(el, 'Jordan Lee: Priority', label);
      expect(onChange).toHaveBeenLastCalledWith(value);
    }
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('shows a value outside the levels as a custom option that cannot be picked', () => {
    const { el, onChange } = select(7);
    const trigger = priorityOf(el, 'Jordan Lee: Priority')!;
    expect(trigger.textContent).toBe('Custom (7)');
    act(() => trigger.click());
    expect(optionLabels(el).map((o) => o.label)).toEqual([
      'Lowest',
      'Low',
      'Medium',
      'High',
      'Highest',
      'Custom (7)',
    ]);
    expect(optionLabels(el).at(-1)!.disabled).toBe(true);
    act(() => [...el.querySelectorAll<HTMLButtonElement>('[role="option"] button')].at(-1)!.click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => root?.unmount());
    // Below Lowest, it sits below Lowest.
    const low = select(-5);
    act(() => priorityOf(low.el, 'Jordan Lee: Priority')!.click());
    expect(optionLabels(low.el)[0]).toEqual({ label: 'Custom (-5)', disabled: true });
  });

  it('in Spanish', () => {
    const { el } = select(3, 'es');
    const trigger = priorityOf(el, 'Jordan Lee: Prioridad')!;
    expect(trigger.textContent).toBe('Personalizada (3)');
    act(() => trigger.click());
    expect(optionLabels(el).map((o) => o.label)).toEqual([
      'Muy baja',
      'Baja',
      'Media',
      'Alta',
      'Muy alta',
      'Personalizada (3)',
    ]);
  });
});

describe('the team event editor saves each host priority', () => {
  const TEAM_EVENT: EventType = {
    id: 'evt-1',
    memberId: null,
    teamId: 'team-1',
    slug: 'team-demo',
    title: 'Team Demo',
    description: null,
    lengthMinutes: 30,
    location: null,
    hidden: false,
    minimumBookingNotice: 0,
    beforeEventBuffer: 0,
    afterEventBuffer: 0,
    slotInterval: null,
    schedulingType: 'round_robin',
    requiresConfirmation: false,
    preventDuplicateBookings: false,
    seatsPerTimeSlot: null,
    bookingFields: [],
    reminders: [],
    hostMemberIds: ['m-alex', 'm-jordan', 'm-riley'],
    hosts: [
      // Set through the API, outside the five levels.
      { memberId: 'm-alex', priority: 7, weight: 100, isFixed: false },
      { memberId: 'm-jordan', priority: null, weight: 100, isFixed: false },
      { memberId: 'm-riley', priority: -1, weight: 50, isFixed: false },
    ],
    scheduleId: null,
    conflictCalendarIds: [],
    destinationCalendarId: null,
    crmPropertyMappings: null,
  };
  const MEMBERS = [
    { memberId: 'm-alex', displayName: 'Alex Rivera' },
    { memberId: 'm-jordan', displayName: 'Jordan Lee' },
    { memberId: 'm-riley', displayName: 'Riley Chen' },
  ];

  beforeEach(() => {
    vi.mocked(saveEventTypeAction).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(listOneOffLinksAction).mockReset().mockResolvedValue({ ok: true, links: [] });
  });

  /** Mounted, with the one-off links list it loads on open already settled. */
  const editor = async (locale: Locale = 'en') => {
    const msgs = getMessages(locale);
    const el = mount(
      <EventTypeForm
        initial={TEAM_EVENT}
        messages={msgs.admin.eventTypes}
        locationLabels={msgs.location}
        scheduling={msgs.scheduling}
        teamMembers={MEMBERS}
        teamName="Sales"
        backHref="/admin/event-types"
        backLabel="Events"
        heading="Team Demo"
        locale={locale}
      />,
    );
    await act(async () => {});
    return el;
  };

  /** Submit the form and return the priorities the save sent, in host order. */
  async function savedPriorities(el: HTMLElement) {
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    });
    const payload = vi.mocked(saveEventTypeAction).mock.lastCall![0] as EventTypePayload;
    return payload.hosts!.map((h) => [h.memberId, h.priority]);
  }

  it('says who a booking goes to, and shows each host at their level', async () => {
    const el = await editor();
    expect(el.textContent).toContain(
      'Each booking goes to the free host with the highest priority; weight shares bookings among hosts at the same level.',
    );
    expect(priorityOf(el, 'Alex Rivera: Priority')!.textContent).toBe('Custom (7)');
    expect(priorityOf(el, 'Jordan Lee: Priority')!.textContent).toBe('Medium');
    expect(priorityOf(el, 'Riley Chen: Priority')!.textContent).toBe('Low');
    // Weight is still a number per host.
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Riley Chen: Weight"]')!.value).toBe('50');
  });

  it('keeps a value outside the levels until a level is picked', async () => {
    const el = await editor();
    expect(await savedPriorities(el)).toEqual([
      ['m-alex', 7],
      ['m-jordan', 0],
      ['m-riley', -1],
    ]);
    pick(el, 'Alex Rivera: Priority', 'Highest');
    expect(priorityOf(el, 'Alex Rivera: Priority')!.textContent).toBe('Highest');
    expect(await savedPriorities(el)).toEqual([
      ['m-alex', 2],
      ['m-jordan', 0],
      ['m-riley', -1],
    ]);
  });

  it('saves every level as -2..2', async () => {
    const el = await editor();
    const levels: Array<[string, number]> = [
      ['Lowest', -2],
      ['Low', -1],
      ['Medium', 0],
      ['High', 1],
      ['Highest', 2],
    ];
    for (const [label, value] of levels) {
      pick(el, 'Jordan Lee: Priority', label);
      expect((await savedPriorities(el))[1]).toEqual(['m-jordan', value]);
    }
  });

  it('collective has no priority', async () => {
    const el = await editor();
    const method = el.querySelector('option[value="collective"]')!.closest('select')!;
    act(() => {
      method.value = 'collective';
      method.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(priorityOf(el, 'Alex Rivera: Priority')).toBeNull();
    expect(el.textContent).not.toContain('Each booking goes to');
  });

  it('in Spanish', async () => {
    const el = await editor('es');
    expect(el.textContent).toContain(
      'Cada reserva va al anfitrión libre con la prioridad más alta; el peso reparte las reservas entre anfitriones del mismo nivel.',
    );
    expect(priorityOf(el, 'Jordan Lee: Prioridad')!.textContent).toBe('Media');
    expect(priorityOf(el, 'Alex Rivera: Prioridad')!.textContent).toBe('Personalizada (7)');
  });
});

describe('HostReadiness', () => {
  const READY = { memberId: 'm-alex', displayName: 'Alex Rivera', hasHours: true, hasCalendar: true };
  const INVITED = { memberId: 'm-casey', displayName: 'Casey Morgan', hasHours: false, hasCalendar: false };
  const NO_CAL = { memberId: 'm-taylor', displayName: null, email: 'taylor@example.com', hasHours: true, hasCalendar: false };
  const box = (el: HTMLElement) => el.querySelector('[data-testid="host-readiness"]');
  const lines = (el: HTMLElement) => [...el.querySelectorAll('[data-testid="host-readiness"] p')].map((p) => p.textContent);

  it('names who gets no bookings for lack of hours, and who has no calendar, apart', () => {
    const en = getMessages('en').admin.eventTypes.teamHosts;
    const el = mount(<HostReadiness hosts={[READY, NO_CAL, INVITED]} collective={false} m={en} locale="en" />);
    expect(lines(el)).toEqual([
      en.noHours.replace('{names}', 'Casey Morgan'),
      en.noCalendar.replace('{names}', 'taylor@example.com'),
    ]);
  });

  it('in a collective event, says no times are offered at all', () => {
    const en = getMessages('en').admin.eventTypes.teamHosts;
    const el = mount(<HostReadiness hosts={[READY, INVITED]} collective m={en} locale="en" />);
    expect(lines(el)).toEqual([en.noHoursCollective.replace('{names}', 'Casey Morgan')]);
  });

  it('says nothing when everyone is ready, or when an older API sends no flags', () => {
    const en = getMessages('en').admin.eventTypes.teamHosts;
    expect(box(mount(<HostReadiness hosts={[READY]} collective={false} m={en} />))).toBeNull();
    expect(
      box(mount(<HostReadiness hosts={[{ memberId: 'm-x', displayName: 'X' }]} collective={false} m={en} />)),
    ).toBeNull();
  });

  it('in Spanish, joining names the Spanish way', () => {
    const es = getMessages('es').admin.eventTypes.teamHosts;
    const other = { ...INVITED, memberId: 'm-riley', displayName: 'Riley Chen' };
    const el = mount(<HostReadiness hosts={[INVITED, other]} collective={false} m={es} locale="es" />);
    expect(lines(el)).toEqual([es.noHours.replace('{names}', 'Casey Morgan y Riley Chen')]);
  });
});
