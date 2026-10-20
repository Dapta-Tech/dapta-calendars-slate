// @vitest-environment jsdom
/**
 * Where a person editing an event finds their team: a personal event's card
 * pointing at team events (one link per team, or "Create a team" when there is
 * none), and a team event's line saying every member hosts it, with the way to
 * the team page. In English and Spanish.
 */
import { act, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';

// No app router is mounted here: a plain anchor.
vi.mock('next/link', () => ({
  default: ({
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

import { PersonalHostsCard, TeamHostsNote } from './team-hosts';

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
      'Every member of Sales hosts this event. Add or remove members on the team page.',
    );
    expect(links(el)).toEqual([
      { text: 'Add or remove members on the team page.', href: '/admin/teams/team-1' },
    ]);
  });

  it('a plain member reads who hosts it, without the roster link', () => {
    const el = note('en', false);
    expect(el.textContent).toBe('Every member of Sales hosts this event.');
    expect(links(el)).toEqual([]);
  });

  it('in Spanish', () => {
    const el = note('es');
    expect(el.textContent).toBe(
      'Todos los miembros de Sales son anfitriones de este evento. Agrega o quita miembros en la página del equipo.',
    );
    expect(links(el)[0]?.href).toBe('/admin/teams/team-1');
  });
});
