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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
// Server actions: stubs, so Sign out can be pressed without leaving the page.
vi.mock('@/app/login/actions', () => ({ signOutAction: vi.fn() }));
// The analytics identity Sign out has to drop; the rest of the port stays real.
const analytics = vi.hoisted(() => ({ resetAnalytics: vi.fn() }));
vi.mock('@/lib/analytics/port', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics/port')>()),
  resetAnalytics: analytics.resetAnalytics,
}));
vi.mock('@/app/admin/account-actions', () => ({ searchAccountsAction: vi.fn(), switchAccountAction: vi.fn() }));

import { signOutAction } from '@/app/login/actions';
import { AdminShell } from './admin-shell';

const DOCS = 'https://docs.example.test/?utm_source=calendars&utm_medium=sidebar';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // The rail's menus are AnchoredMenus, which re-measure on resize; jsdom has none.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // No layout in jsdom: a menu whose trigger measures 0x0 closes itself (the
  // trigger is hidden), so every element gets a size, as dForms' rail specs do.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 10, y: 200, width: 44, height: 44 }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface ShellOpts {
  pathname?: string;
  isAdmin?: boolean;
  docsHref?: string | null;
  collapsed?: boolean;
  locale?: Locale;
  accounts?: { id: string; accountId: string; name: string }[];
}

function shell(opts: ShellOpts) {
  return (
    <AdminShell
      user={{ displayName: 'Alex Rivera', email: 'alex@example.com', handle: 'alex-rivera', accountCode: 'acme' }}
      accounts={opts.accounts}
      currentAccountId={opts.accounts?.[0]?.accountId ?? null}
      messages={getMessages(opts.locale ?? 'en').admin}
      initialTheme="light"
      initialCollapsed={opts.collapsed ?? false}
      isAdmin={opts.isAdmin ?? true}
      docsHref={opts.docsHref === undefined ? DOCS : opts.docsHref}
    >
      <p>page</p>
    </AdminShell>
  );
}

async function mount(opts: ShellOpts) {
  nav.pathname = opts.pathname ?? '/admin';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(shell(opts)));
  return host;
}

/** A client navigation: the shell stays mounted and the path changes under it. */
async function navigate(pathname: string, opts: ShellOpts = {}) {
  nav.pathname = pathname;
  await act(async () => root!.render(shell({ ...opts, pathname })));
}

const activeLogo = (rail: Element) => rail.querySelector('[data-testid="mcp-logos"] [data-active="true"]')!.getAttribute('data-logo');

/** The desktop rail and the mobile drawer, in DOM order. */
function rails(el: HTMLElement) {
  const [desktop, drawer] = Array.from(el.querySelectorAll('aside'));
  return { desktop: desktop!, drawer: drawer! };
}

const trigger = (rail: Element) => rail.querySelector<HTMLButtonElement>('[data-testid="nav-developers"]');
const docsLink = (rail: Element) => rail.querySelector<HTMLAnchorElement>('[data-testid="nav-docs"]');
const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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
    const menu = document.querySelector<HTMLElement>('[data-testid="nav-developers-flyout"]')!;
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
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes the flyout on Tab and puts focus back on the MCP item, so Tab moves on from there', async () => {
    const el = await mount({ pathname: '/admin', collapsed: true });
    const { desktop } = rails(el);
    const button = trigger(desktop)!;
    await act(async () => button.click());
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).not.toBeNull();
    await press(document.activeElement!, 'Tab');
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens again on a navigation into the group, even after it was closed by hand', async () => {
    const el = await mount({ pathname: '/admin/developers/keys' });
    const button = trigger(rails(el).desktop)!;
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await navigate('/admin/bookings');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await navigate('/admin/developers/docs');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const current = rails(el).desktop.querySelector('[data-testid="nav-developers-pages"] [aria-current="page"]');
    expect(current?.textContent).toBe('API docs');
  });

  it('turns the logos, holds them under keyboard focus, and never in the closed drawer', async () => {
    vi.useFakeTimers();
    try {
      const el = await mount({});
      const { desktop, drawer } = rails(el);
      expect(activeLogo(desktop)).toBe('claude');
      await act(async () => vi.advanceTimersByTime(2600));
      expect(activeLogo(desktop)).toBe('openai');
      // Off screen: the closed drawer's copy has not moved.
      expect(activeLogo(drawer)).toBe('claude');

      await act(async () => trigger(desktop)!.focus());
      await act(async () => vi.advanceTimersByTime(2600 * 2));
      expect(activeLogo(desktop)).toBe('openai');
      await act(async () => trigger(desktop)!.blur());
      await act(async () => vi.advanceTimersByTime(2600));
      expect(activeLogo(desktop)).toBe('cursor');
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the flyout on a click elsewhere, and after a page is picked', async () => {
    const el = await mount({ pathname: '/admin', collapsed: true });
    const { desktop } = rails(el);
    const button = trigger(desktop)!;
    await act(async () => button.click());
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).not.toBeNull();
    await act(async () => {
      el.querySelector('main')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();

    await act(async () => button.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="nav-developers-flyout-docs"]')!.click());
    expect(document.querySelector('[data-testid="nav-developers-flyout"]')).toBeNull();
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

describe('AdminShell: the dForms rail look', () => {
  it('sits on the sidebar ground, pinned to the window at its full height, in both rails', async () => {
    const el = await mount({});
    const { desktop, drawer } = rails(el);
    // 100vh first, 100dvh where the browser knows it.
    for (const cls of ['bg-sidebar', 'md:sticky', 'md:top-0', 'md:h-screen', 'md:supports-[height:100dvh]:h-dvh']) {
      expect(desktop.className.split(' ')).toContain(cls);
    }
    expect(drawer.className).toContain('bg-sidebar');
    // Containment is `inert`, not aria-modal: the rail's menus live at the end of <body>.
    expect(drawer.hasAttribute('aria-modal')).toBe(false);
  });

  it('scrolls only the nav: the wordmark above it and the footer below it never move', async () => {
    const el = await mount({ pathname: '/admin/developers/keys' });
    for (const rail of Object.values(rails(el))) {
      const nav = rail.querySelector('nav')!;
      for (const cls of ['min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain']) {
        expect(nav.className.split(' ')).toContain(cls);
      }
      const foot = rail.querySelector('[data-testid="profile-menu-trigger"]')!.parentElement!;
      expect(nav.contains(foot)).toBe(false);
      expect(foot.className.split(' ')).toContain('shrink-0');
      expect(foot.className).not.toContain('sticky');
      // Wordmark, nav, footer: the footer comes after the list, not inside it.
      expect(nav.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('marks the current row with the wash and the accent bar, and no other row', async () => {
    const el = await mount({ pathname: '/admin/bookings' });
    const links = Array.from(rails(el).desktop.querySelectorAll<HTMLAnchorElement>('nav a'));
    const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Bookings']);
    expect(current[0]!.className).toContain('before:bg-primary-edge');
    expect(current[0]!.className).toContain('bg-muted');
    for (const a of links.filter((x) => x !== current[0])) expect(a.className).not.toContain('before:bg-primary-edge');
  });

  it('ends with the person: name and email on one button whose menu holds the public page and Sign out', async () => {
    const el = await mount({});
    const { desktop } = rails(el);
    const trigger = desktop.querySelector<HTMLButtonElement>('[data-testid="profile-menu-trigger"]')!;
    expect(trigger.textContent).toContain('Alex Rivera');
    expect(trigger.textContent).toContain('alex@example.com');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    // No loose icon actions beside the name any more.
    expect(desktop.querySelector('a[href="/acme/alex-rivera"]')).toBeNull();
    expect(desktop.querySelector('form button[type="submit"]')).toBeNull();

    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[data-testid="profile-menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Account menu');
    const view = menu.querySelector<HTMLAnchorElement>('[data-testid="profile-view-public"]')!;
    expect(view.getAttribute('href')).toBe('/acme/alex-rivera');
    expect(view.getAttribute('target')).toBe('_blank');
    expect(menu.querySelector('[data-testid="profile-sign-out"]')!.textContent).toBe('Sign out');
    expect(document.activeElement).toBe(view);
  });

  it('puts the account card under the wordmark, above the nav, for staff who can switch', async () => {
    const el = await mount({ accounts: [{ id: '1', accountId: 'acc-1', name: 'Northwind' }] });
    const desktop = rails(el).desktop;
    const card = desktop.querySelector('[data-testid="account-switcher-trigger"]')!;
    expect(card.textContent).toContain('Northwind');
    const nav = desktop.querySelector('nav')!;
    expect(card.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Everyone else has no list to pick from, so nothing renders.
    act(() => root?.unmount());
    host?.remove();
    const plain = await mount({});
    expect(plain.querySelector('[data-testid="account-switcher-trigger"]')).toBeNull();
  });

  it('closes only the menu on Escape inside the open drawer', async () => {
    const el = await mount({});
    const hamburger = Array.from(el.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Open navigation')!;
    await act(async () => hamburger.click());
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');
    const trigger = rails(el).drawer.querySelector<HTMLButtonElement>('[data-testid="profile-menu-trigger"]')!;
    await act(async () => trigger.click());
    expect(document.querySelector('[data-testid="profile-menu"]')).not.toBeNull();
    await press(document.activeElement!, 'Escape');
    expect(document.querySelector('[data-testid="profile-menu"]')).toBeNull();
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');
  });

  it('ends the list with the Dapta Agents door when the deployment has a platform, and only then', async () => {
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_URL', 'https://platform.example.test/');
    vi.resetModules();
    try {
      const { AdminShell: WithPlatform } = await import('./admin-shell');
      nav.pathname = '/admin';
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root!.render(
          <WithPlatform
            user={{ displayName: 'Alex Rivera', email: null, handle: null, accountCode: 'acme' }}
            messages={getMessages('en').admin}
            initialTheme="light"
            isAdmin
            docsHref={DOCS}
          >
            <p>page</p>
          </WithPlatform>,
        ),
      );
      const items = rails(host).desktop.querySelectorAll('nav > ul > li');
      const door = items[items.length - 1]!.querySelector<HTMLAnchorElement>('[data-testid="nav-agents"]')!;
      expect(door.textContent).toContain('Dapta Agents');
      expect(door.getAttribute('target')).toBe('_blank');
      const href = new URL(door.getAttribute('href')!);
      expect(href.origin).toBe('https://platform.example.test');
      expect(href.searchParams.get('utm_source')).toBe('calendars');
      expect(href.searchParams.get('utm_medium')).toBe('sidebar');
    } finally {
      vi.unstubAllEnvs();
    }
    // The module this file imported at the top read no platform: no door.
    const el = await mount({});
    expect(el.querySelector('[data-testid="nav-agents"]')).toBeNull();
  });
});

describe('AdminShell: the rail menus by keyboard', () => {
  async function openProfile() {
    const el = await mount({});
    const trigger = rails(el).desktop.querySelector<HTMLButtonElement>('[data-testid="profile-menu-trigger"]')!;
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[data-testid="profile-menu"]')!;
    return { trigger, menu };
  }

  it('moves between the profile menu items with the arrows, Home and End', async () => {
    const { menu } = await openProfile();
    const [view, signOut] = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(document.activeElement).toBe(view);
    await press(view!, 'ArrowDown');
    expect(document.activeElement).toBe(signOut);
    await press(signOut!, 'ArrowDown');
    expect(document.activeElement).toBe(view);
    await press(view!, 'End');
    expect(document.activeElement).toBe(signOut);
    await press(signOut!, 'Home');
    expect(document.activeElement).toBe(view);
  });

  it('closes the profile menu on Tab and hands focus to its button, so Tab moves on from the rail', async () => {
    const { trigger, menu } = await openProfile();
    const signOut = menu.querySelector<HTMLElement>('[data-testid="profile-sign-out"]')!;
    signOut.focus();
    await press(signOut, 'Tab');
    expect(document.querySelector('[data-testid="profile-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab inside the account picker (a dialog) until it steps off either end', async () => {
    const el = await mount({
      accounts: [
        { id: '1', accountId: 'acc-1', name: 'Northwind' },
        { id: '2', accountId: 'acc-2', name: 'Contoso' },
      ],
    });
    const trigger = rails(el).desktop.querySelector<HTMLButtonElement>('[data-testid="account-switcher-trigger"]')!;
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>('[data-testid="account-switcher-menu"]')!;
    // A dialog has no menu items: focus goes to its first field once placed.
    expect(document.activeElement).toBe(panel.querySelector('input[type="search"]'));
    const tabbable = Array.from(
      panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled])'),
    );
    expect(tabbable.length).toBeGreaterThan(1);
    tabbable[0]!.focus();
    await press(tabbable[0]!, 'Tab');
    expect(document.querySelector('[data-testid="account-switcher-menu"]')).not.toBeNull();
    const last = tabbable[tabbable.length - 1]!;
    last.focus();
    await press(last, 'Tab');
    expect(document.querySelector('[data-testid="account-switcher-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('drops the analytics identity on Sign out, before the session goes', async () => {
    const { menu } = await openProfile();
    analytics.resetAnalytics.mockClear();
    await act(async () => menu.querySelector<HTMLButtonElement>('[data-testid="profile-sign-out"]')!.click());
    expect(analytics.resetAnalytics).toHaveBeenCalledTimes(1);
    expect(signOutAction).toHaveBeenCalled();
  });
});

describe('AdminShell: a fork', () => {
  it('shows its chip and name once in the mobile top bar, with the classes on wrappers', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_NAME', 'Acme Booking');
    vi.resetModules();
    try {
      const { AdminShell: Fork } = await import('./admin-shell');
      nav.pathname = '/admin';
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root!.render(
          <Fork
            user={{ displayName: 'Alex Rivera', email: null, handle: null, accountCode: 'acme' }}
            messages={getMessages('en').admin}
            initialTheme="light"
            isAdmin
            docsHref={DOCS}
          >
            <p>page</p>
          </Fork>,
        ),
      );
      const header = host.querySelector('header')!;
      // The menu button, then exactly the two brand wrappers: nothing else.
      const [, wide, narrow, ...rest] = Array.from(header.children) as HTMLElement[];
      expect(rest).toHaveLength(0);
      expect(wide!.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'min-[360px]:flex']));
      expect(narrow!.className.split(' ')).toEqual(expect.arrayContaining(['min-[360px]:hidden']));
      expect(wide!.textContent).toBe('AAcme Booking');
      expect(narrow!.textContent).toBe('A');
      expect(header.querySelector('svg')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
