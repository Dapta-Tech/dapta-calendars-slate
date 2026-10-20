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
  const card = (locale: Locale, teams = TEAMS) => {
    const m = getMessages(locale).admin.eventTypes;
    return mount(<PersonalHostsCard teams={teams} title={m.hostsTitle} m={m.teamHosts} />);
  };

  it('says the event is only yours and offers a team event on each team', () => {
    const el = card('en');
    expect(el.textContent).toContain('Hosts');
    expect(el.textContent).toContain(
      'This event is only yours. To share bookings with your team (round-robin or all together), create a team event.',
    );
    expect(links(el)).toEqual([
      {
        text: 'New event for Sales',
        href: '/admin/event-types/new?teamId=team-1',
      },
      {
        text: 'New event for Ventas LatAm',
        href: '/admin/event-types/new?teamId=team-2',
      },
    ]);
  });

  it('with no team yet, the one way forward is to create one', () => {
    const el = card('en', []);
    expect(links(el)).toEqual([{ text: 'Create a team', href: '/admin/teams/new' }]);
  });

  it('in Spanish', () => {
    const el = card('es');
    expect(el.textContent).toContain('Anfitriones');
    expect(el.textContent).toContain('Este evento es solo tuyo.');
    expect(links(el).map((l) => l.text)).toEqual([
      'Nuevo evento para Sales',
      'Nuevo evento para Ventas LatAm',
    ]);
    expect(links(card('es', [])).map((l) => l.text)).toEqual(['Crear un equipo']);
  });
});

describe('TeamHostsNote', () => {
  const note = (locale: Locale) =>
    mount(
      <TeamHostsNote
        teamId="team-1"
        teamName="Sales"
        m={getMessages(locale).admin.eventTypes.teamHosts}
      />,
    );

  it('names the team as the hosts and links to where its members are managed', () => {
    const el = note('en');
    expect(el.textContent).toBe(
      'Every member of Sales hosts this event. Add or remove members on the team page.',
    );
    expect(links(el)).toEqual([
      {
        text: 'Add or remove members on the team page.',
        href: '/admin/teams/team-1',
      },
    ]);
  });

  it('in Spanish', () => {
    const el = note('es');
    expect(el.textContent).toBe(
      'Todos los miembros de Sales son anfitriones de este evento. Agrega o quita miembros en la página del equipo.',
    );
    expect(links(el)[0]?.href).toBe('/admin/teams/team-1');
  });
});
