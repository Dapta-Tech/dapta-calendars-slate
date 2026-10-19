// @vitest-environment jsdom
/**
 * The rail's MCP group and Docs item, driven like a person would: who sees
 * them, the accordion in the wide rail and the mobile drawer, the flyout menu
 * on the collapsed rail (arrow keys, Escape, focus handed back), and the Docs
 * link leaving the app in a new tab.
 *
 * Both rails are in the markup at once (the drawer is translated off screen,
 * not unmounted), so one render covers the desktop rail and the drawer.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';

const nav = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
// No app router is mounted here: a plain anchor that does not navigate.
vi.mock('next/link', () => ({
  default: ({ children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));
// Server actions: never called here, only imported by the footer's controls.
vi.mock('@/app/login/actions', () => ({ signOutAction: vi.fn() }));
vi.mock('@/app/admin/account-actions', () => ({ searchAccountsAction: vi.fn(), switchAccountAction: vi.fn() }));

import { AdminShell } from './admin-shell';

const DOCS = 'https://docs.example.test/?utm_source=calendars&utm_medium=sidebar';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(opts: {
  pathname?: string;
  isAdmin?: boolean;
  docsHref?: string | null;
  collapsed?: boolean;
  locale?: Locale;
}) {
  nav.pathname = opts.pathname ?? '/admin';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <AdminShell
        user={{ displayName: 'Alex Rivera', handle: 'alex-rivera', accountCode: 'acme' }}
        messages={getMessages(opts.locale ?? 'en').admin}
        initialTheme="light"
        initialCollapsed={opts.collapsed ?? false}
        isAdmin={opts.isAdmin ?? true}
        docsHref={opts.docsHref === undefined ? DOCS : opts.docsHref}
      >
        <p>page</p>
      </AdminShell>,
    ),
  );
  return host;
}

/** The desktop rail and the mobile drawer, in DOM order. */
function rails(el: HTMLElement) {
  const [desktop, drawer] = Array.from(el.querySelectorAll('aside'));
  return { desktop: desktop!, drawer: drawer! };
}

const trigger = (rail: Element) => rail.querySelector<HTMLButtonElement>('[data-testid="nav-developers"]');
const docsLink = (rail: Element) => rail.querySelector<HTMLAnchorElement>('[data-testid="nav-docs"]');
const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('AdminShell: the MCP group', () => {
  it('is in both rails for an owner or admin, after Settings, with the rotating logos as its icon', async () => {
    const el = await mount({});
    for (const rail of Object.values(rails(el))) {
      const button = trigger(rail);
      expect(button).not.toBeNull();
      expect(button!.textContent).toContain('MCP');
      const logos = Array.from(button!.querySelectorAll('[data-logo]')).map((l) => l.getAttribute('data-logo'));
      expect(logos).toEqual(['claude', 'openai', 'cursor']);
      expect(button!.querySelector('[data-testid="mcp-logos"]')!.getAttribute('aria-hidden')).toBe('true');
      // After Settings, before Docs: the order dForms uses for the same two items.
      const labels = Array.from(rail.querySelectorAll('nav > ul > li')).map((li) => li.textContent?.trim());
      expect(labels.indexOf('Settings')).toBe(labels.findIndex((l) => l?.startsWith('MCP')) - 1);
    }
  });

  it('is not there for a plain member, who could only reach "no access" through it', async () => {
    const el = await mount({ isAdmin: false });
    expect(el.querySelector('[data-testid="nav-developers"]')).toBeNull();
    expect(el.innerHTML).not.toContain('/admin/developers');
  });

  it('opens by itself on one of its pages and marks that page, in the rail and the drawer', async () => {
    const el = await mount({ pathname: '/admin/developers/webhooks' });
    for (const rail of Object.values(rails(el))) {
      expect(trigger(rail)!.getAttribute('aria-expanded')).toBe('true');
      const pages = rail.querySelector('[data-testid="nav-developers-pages"]')!;
      expect(trigger(rail)!.getAttribute('aria-controls')).toBe(pages.id);
      const links = Array.from(pages.querySelectorAll('a'));
      expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
        ['Connect and keys', '/admin/developers/keys'],
        ['Webhooks', '/admin/developers/webhooks'],
        ['API docs', '/admin/developers/docs'],
      ]);
      expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    }
  });

  it('starts closed elsewhere, and the button toggles it', async () => {
    const el = await mount({ pathname: '/admin/bookings' });
    const { desktop } = rails(el);
    const button = trigger(desktop)!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(desktop.querySelector('[data-testid="nav-developers-pages"]')).toBeNull();
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(desktop.querySelectorAll('[data-testid="nav-developers-pages"] a')).toHaveLength(3);
    await act(async () => button.click());
    expect(desktop.querySelector('[data-testid="nav-developers-pages"]')).toBeNull();
  });

  it('is a menu button on the collapsed rail: arrows move, Escape closes and hands focus back', async () => {
    const el = await mount({ pathname: '/admin/developers/keys', collapsed: true });
    const { desktop } = rails(el);
    const button = trigger(desktop)!;
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Icon only, but the name is still there for a screen reader.
    expect(button.querySelector('.sr-only')!.textContent).toBe('MCP');

    await act(async () => button.click());
    const menu = desktop.querySelector<HTMLElement>('[data-testid="nav-developers-flyout"]')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('MCP');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((i) => i.textContent)).toEqual(['Connect and keys', 'Webhooks', 'API docs']);
    expect(items[0]!.getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(items[0]);

    await press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await press(document.activeElement!, 'End');
    expect(document.activeElement).toBe(items[2]);
    await press(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await press(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(items[2]);

    await press(document.activeElement!, 'Escape');
    expect(desktop.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes the flyout on a click elsewhere, and after a page is picked', async () => {
    const el = await mount({ pathname: '/admin', collapsed: true });
    const { desktop } = rails(el);
    const button = trigger(desktop)!;
    await act(async () => button.click());
    expect(desktop.querySelector('[data-testid="nav-developers-flyout"]')).not.toBeNull();
    await act(async () => {
      el.querySelector('main')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(desktop.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();

    await act(async () => button.click());
    await act(async () => desktop.querySelector<HTMLElement>('[data-testid="nav-developers-flyout-docs"]')!.click());
    expect(desktop.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();
  });

  it('reads in Spanish for a Spanish reader', async () => {
    const el = await mount({ pathname: '/admin/developers/keys', locale: 'es' });
    const pages = rails(el).desktop.querySelectorAll('[data-testid="nav-developers-pages"] a');
    expect(Array.from(pages).map((a) => a.textContent)).toEqual(['Conexión y claves', 'Webhooks', 'Docs de la API']);
  });
});

describe('AdminShell: the Docs item', () => {
  it('leaves the app in a new tab, to exactly the address the server resolved, in both rails', async () => {
    const el = await mount({ isAdmin: false });
    for (const rail of Object.values(rails(el))) {
      const a = docsLink(rail)!;
      expect(a.getAttribute('href')).toBe(DOCS);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      // Never "the current page", and a screen reader hears that it opens a tab.
      expect(a.hasAttribute('aria-current')).toBe(false);
      expect(a.querySelector('.sr-only:last-child')!.textContent).toContain('(opens in a new tab)');
    }
  });

  it('is last in the rail', async () => {
    const el = await mount({});
    const items = rails(el).desktop.querySelectorAll('nav > ul > li');
    expect(items[items.length - 1]!.querySelector('[data-testid="nav-docs"]')).not.toBeNull();
  });

  it('is not there when the deployment configures no docs', async () => {
    const el = await mount({ docsHref: null });
    expect(el.querySelector('[data-testid="nav-docs"]')).toBeNull();
  });

  it('keeps its name on the collapsed rail, where only the icon shows', async () => {
    const el = await mount({ collapsed: true, locale: 'es' });
    const a = docsLink(rails(el).desktop)!;
    expect(a.getAttribute('title')).toBe('Documentación');
    expect(a.querySelector('.sr-only')!.textContent).toBe('Documentación');
  });
});
