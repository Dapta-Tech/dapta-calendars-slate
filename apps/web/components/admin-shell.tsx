'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, type BookingMessages } from '@slate/shared';
import { signOutAction } from '@/app/login/actions';
import { resetAnalytics } from '@/lib/analytics/port';
import { adminNav, type NavIcon, type NavItem, type SubNavItem } from '@/lib/admin-nav';
import { AccountSwitcher, type AccountOption } from '@/components/account-switcher';
import { AppSwitcher } from '@/components/app-switcher';
import { BrandMark, PRODUCT_NAME } from '@/components/brand/brand';
import { McpLogos } from '@/components/mcp-logos';
import { ThemeToggle } from '@/components/theme-toggle';
import type { Theme } from '@/lib/theme';

type AdminMessages = BookingMessages['admin'];

/** Design-parity admin shell — mirrors the old Angular app-shell: a flush 240px
 *  sidebar (bg-popover, right border, never a floating card), a flat nav in the
 *  original order (see `lib/admin-nav.ts`), a bottom user footer, a desktop
 *  collapse rail (localStorage-persisted), and a <768px off-canvas drawer with a
 *  hamburger top bar. Tokens only (no raw hex); R22 press/hover feedback; R27/R28. */

const NAV_COLLAPSED_KEY = 'slate.nav.collapsed';

// Dapta's icon system is PrimeIcons (pi pi-*) — the same set the production
// Angular admin panel uses. Nav glyphs map 1:1 to their pi names; sized at the
// design-system's 20px sidebar icon. MCP is the one exception: its icon is the
// rotating AI app logos, same 20px.
const PI_BY_NAME: Record<Exclude<NavIcon, 'mcp'>, string> = {
  home: 'pi-home',
  calendar: 'pi-calendar',
  clock: 'pi-clock',
  ticket: 'pi-ticket',
  users: 'pi-users',
  calendarPlus: 'pi-calendar-plus',
  cog: 'pi-cog',
  book: 'pi-book',
};

function Icon({ name, paused }: { name: NavIcon; paused?: boolean }) {
  if (name === 'mcp') return <McpLogos size={20} paused={paused} />;
  return <i aria-hidden className={`pi ${PI_BY_NAME[name]}`} style={{ fontSize: 20 }} />;
}

/**
 * The look of one rail row. `parent` is a group whose open accordion already
 * shows the current page under it: it reads as "you are in here" without the
 * wash, which belongs to the one row that IS the page.
 */
function navRowClass(collapsed: boolean, state: 'active' | 'parent' | 'idle') {
  return [
    'flex items-center gap-field rounded-md text-sm transition-colors active:scale-[0.99]',
    collapsed ? 'mx-auto h-11 w-11 justify-center gap-0 px-0' : 'min-h-control w-full px-field py-field text-left',
    state === 'active'
      ? 'bg-muted font-medium text-foreground'
      : state === 'parent'
        ? 'font-medium text-foreground hover:bg-muted'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  ].join(' ');
}

/**
 * A rail item with pages under it (MCP). One `<button>` in both rail widths:
 *
 *  - Wide rail and drawer: a disclosure. The pages show indented below it, and
 *    open on their own whenever the current route is one of them.
 *  - Collapsed rail: a menu button. The pages open in a flyout beside the icon
 *    (WAI-ARIA menu button: focus lands on the first page, the arrow keys, Home
 *    and End move, Escape or a click elsewhere closes and hands focus back).
 *
 * The flyout is positioned against the item itself. The desktop rail opens no
 * stacking context (no transform, no z-index, no sticky), so the panel's z-50
 * ranks against the page and paints over it.
 */
function NavGroup({
  item,
  pages,
  collapsed,
  label,
  labels,
  onNavigate,
}: {
  item: NavItem;
  pages: readonly SubNavItem[];
  collapsed: boolean;
  label: string;
  labels: AdminMessages['developerNav'];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const inside = isNavItemActive(pathname, item.href);
  const [open, setOpen] = useState(inside);
  const [flyout, setFlyout] = useState(false);
  // The rotating logos hold still under the pointer (see McpLogos).
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const closeFlyout = useCallback((refocus: boolean) => {
    setFlyout(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Arriving on one of the pages opens the group, including after the person
  // closed it by hand and then followed a link here from somewhere else.
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside, pathname]);

  // The flyout belongs to the 64px rail; if the rail widens under it, the
  // accordion takes over.
  useEffect(() => {
    if (!collapsed) setFlyout(false);
  }, [collapsed]);

  useEffect(() => {
    if (!flyout) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeFlyout(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFlyout(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyout, closeFlyout]);

  const state = !inside ? 'idle' : collapsed || !open ? 'active' : 'parent';

  const onFlyoutKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Leaving the menu by Tab closes it; focus moves on as the browser decides.
      setFlyout(false);
      return;
    }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={`nav-${item.key}`}
        onClick={() => (collapsed ? setFlyout((v) => !v) : setOpen((v) => !v))}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        aria-haspopup={collapsed ? 'menu' : undefined}
        aria-expanded={collapsed ? flyout : open}
        aria-controls={!collapsed && open ? listId : undefined}
        title={collapsed ? label : undefined}
        className={navRowClass(collapsed, state)}
      >
        <Icon name={item.icon} paused={hovered} />
        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{label}</span>
        {!collapsed ? (
          <i
            aria-hidden
            className={`pi pi-chevron-down ml-auto shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            style={{ fontSize: 12 }}
          />
        ) : null}
      </button>

      {!collapsed && open ? (
        <ul id={listId} className="mt-tight flex flex-col gap-tight" data-testid={`nav-${item.key}-pages`}>
          {pages.map((page) => {
            const active = isNavItemActive(pathname, page.href);
            return (
              <li key={page.key}>
                <Link
                  href={page.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  data-testid={`nav-${item.key}-${page.key}`}
                  // pl-11 sets the label on the parent label's column (12px
                  // padding + 20px icon + 12px gap), which is what reads as
                  // "under MCP" without a second icon per row.
                  className={[
                    'flex min-h-control items-center rounded-md py-inline pl-11 pr-field text-sm transition-colors active:scale-[0.99]',
                    active
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  ].join(' ')}
                >
                  <span className="min-w-0 truncate">{labels[page.key]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}

      {collapsed && flyout ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onFlyoutKeyDown}
          data-testid={`nav-${item.key}-flyout`}
          className="absolute left-full top-0 z-50 ml-field flex w-56 flex-col rounded-md border border-border bg-popover py-tight text-popover-foreground shadow-lg"
        >
          {/* The group's name, for the eye: the icon alone said nothing. */}
          <p aria-hidden className="px-field py-tight text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {pages.map((page) => {
            const active = isNavItemActive(pathname, page.href);
            return (
              <Link
                key={page.key}
                href={page.href}
                role="menuitem"
                aria-current={active ? 'page' : undefined}
                data-testid={`nav-${item.key}-flyout-${page.key}`}
                onClick={() => {
                  closeFlyout(false);
                  onNavigate?.();
                }}
                className={`flex min-h-control w-full items-center gap-inline px-field text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted ${
                  active ? 'bg-muted font-medium text-foreground' : 'text-foreground'
                }`}
              >
                <i
                  aria-hidden
                  className={`pi ${page.icon} ${active ? 'text-foreground' : 'text-muted-foreground'}`}
                  style={{ fontSize: 16 }}
                />
                <span className="min-w-0 flex-1 truncate">{labels[page.key]}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function NavLinks({
  items,
  collapsed,
  nav,
  pages,
  newTab,
  onNavigate,
}: {
  items: readonly NavItem[];
  collapsed: boolean;
  nav: AdminMessages['nav'];
  /** Labels of the pages under MCP. */
  pages: AdminMessages['developerNav'];
  /** "(opens in a new tab)", read out after an external item's label. */
  newTab: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-tight">
      {items.map((item) => {
        const label = nav[item.key];
        if (item.children) {
          return (
            <li key={item.key}>
              <NavGroup
                item={item}
                pages={item.children}
                collapsed={collapsed}
                label={label}
                labels={pages}
                onNavigate={onNavigate}
              />
            </li>
          );
        }
        // An external item is never "here": its href is another origin.
        const active = !item.external && isNavItemActive(pathname, item.href, item.match);
        const className = navRowClass(collapsed, active ? 'active' : 'idle');
        // Label stays in the a11y tree when collapsed (sr-only) so the
        // icon-only link keeps a discernible name (WCAG 4.1.2).
        const body = (
          <>
            <Icon name={item.icon} />
            <span className={collapsed ? 'sr-only' : ''}>{label}</span>
          </>
        );
        return (
          <li key={item.key}>
            {item.external ? (
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onNavigate}
                title={collapsed ? label : undefined}
                data-testid={`nav-${item.key}`}
                className={className}
              >
                {body}
                {/* The arrow the app switcher's external rows carry, so "leaves
                    the app" reads the same wherever it appears. Hidden on the
                    64px rail, where the 44px tile is the icon alone. */}
                {!collapsed ? (
                  <i aria-hidden className="pi pi-external-link ml-auto text-muted-foreground" style={{ fontSize: 14 }} />
                ) : null}
                <span className="sr-only"> {newTab}</span>
              </a>
            ) : (
              <Link
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? label : undefined}
                aria-current={active ? 'page' : undefined}
                className={className}
              >
                {body}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface ShellUser {
  displayName: string | null;
  handle: string | null;
  accountCode: string;
}

export function AdminShell({
  user,
  accounts = [],
  accountsHasMore = false,
  currentAccountId = null,
  messages,
  initialCollapsed = false,
  initialTheme,
  isAdmin = false,
  docsHref = null,
  children,
}: {
  user: ShellUser | null;
  /** First page of the accounts this login may switch between — empty for
   *  everyone but operator staff, who search the rest from the picker. */
  accounts?: AccountOption[];
  accountsHasMore?: boolean;
  currentAccountId?: string | null;
  /** Active-locale admin catalog (F8) — nav + common labels. */
  messages: AdminMessages;
  /** Server-read cookie value → no collapse-rail FOUC on reload. */
  initialCollapsed?: boolean;
  /** Server-read cookie value → the toggle's icon is right on the first paint,
   *  same reason and same shape as `initialCollapsed` (#90). */
  initialTheme: Theme;
  /** Owner or admin: the only roles the MCP pages serve, so the only ones who get the item. */
  isAdmin?: boolean;
  /** The documentation in the reader's language, already tagged; null hides the Docs item. */
  docsHref?: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const c = messages.common;
  const items = adminNav({ isAdmin, docsHref });
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // Owned here, not in ThemeToggle: the footer renders twice (desktop rail and
  // mobile drawer) and both instances have to agree across a resize.
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  // The booking-page studio wants the widest canvas → force the rail collapsed
  // on that route (old app's isStudio parity), without touching the saved pref.
  const studio = pathname.startsWith('/admin/settings/booking-page');
  const railCollapsed = collapsed || studio;

  // Persist the desktop rail preference to a cookie so the SERVER renders the
  // correct width on the next load (no flash) — see AdminLayout.
  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
        const secure = window.location.protocol === 'https:' ? '; secure' : '';
        document.cookie = `${NAV_COLLAPSED_KEY}=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax${secure}`;
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Lock body scroll + close on Escape + move focus into the drawer on open (R28).
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    if (drawerOpen) drawerRef.current?.querySelector<HTMLElement>('a,button')?.focus();
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const initial = (user?.displayName?.trim()?.charAt(0) || 'A').toUpperCase();
  const userLabel = user?.displayName ?? 'Not signed in';

  const brand = (
    <div className={`flex items-center gap-inline ${railCollapsed ? 'flex-col px-0' : 'px-inline'}`}>
      {/* The mark carries the name only while the wordmark span is hidden, so
          assistive tech hears the product once either way. */}
      <BrandMark className="h-6 w-auto text-foreground" labelled={railCollapsed} />
      {!railCollapsed ? <span className="text-sm font-semibold text-foreground">{PRODUCT_NAME}</span> : null}
      <AppSwitcher messages={c.switcher} />
      {/* The rail toggle is a desktop pref; hidden on the studio route where the
          rail is force-collapsed for canvas. */}
      {!studio ? (
        <button
          type="button"
          onClick={toggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? c.expand : c.collapse}
          title={collapsed ? c.expand : c.collapse}
          className={`hidden rounded-md p-inline text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98] md:inline-flex ${collapsed ? '' : 'ml-auto'}`}
        >
          <i aria-hidden className={`pi ${collapsed ? 'pi-angle-double-right' : 'pi-angle-double-left'}`} style={{ fontSize: 16 }} />
        </button>
      ) : null}
    </div>
  );

  // The mobile drawer is always full-width, so its footer must render expanded
  // regardless of the DESKTOP rail state — hence a param, not the shared const.
  const viewPublic = user?.handle ? (
    <Link
      href={`/${user.accountCode}/${user.handle}`}
      target="_blank"
      rel="noopener noreferrer"
      title={c.viewPublic}
      aria-label={`${c.viewPublic} (opens in a new tab)`}
      className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]"
    >
      <i aria-hidden className="pi pi-external-link" style={{ fontSize: 16 }} />
    </Link>
  ) : null;

  // Sign-out (local provider): a server action clears the session cookie.
  const signOut = (
    // The analytics identity goes with the session: the next person to use
    // this browser must not be filed as this host.
    <form action={signOutAction} onSubmit={() => resetAnalytics()}>
      <button
        type="submit"
        title={c.signOut}
        aria-label={c.signOut}
        className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]"
      >
        <i aria-hidden className="pi pi-sign-out" style={{ fontSize: 16 }} />
      </button>
    </form>
  );

  // Identity on one row, icon actions on the next.
  //
  // They shared a single row while there were two actions. A third (the theme
  // toggle) does not fit: three 44px targets plus the avatar leave 25px for the
  // name in a 240px rail, which truncates "Alex Rivera" to nothing. Dropping to
  // a smaller target to buy the room would trade a legible name for a hit area
  // below the 44px floor, so the row splits instead — the one direction the rail
  // has to spare.
  const renderFooter = (footerCollapsed: boolean) => (
    <div
      className={`mt-auto flex flex-col border-t border-border pt-field ${
        footerCollapsed ? 'items-center gap-tight' : 'gap-inline'
      }`}
    >
      {/* Above the identity row: which account you are acting in frames who you
          are, and the two read together the way the platform app's do. */}
      <AccountSwitcher
        accounts={accounts}
        hasMore={accountsHasMore}
        currentAccountId={currentAccountId}
        fallbackLabel={user?.accountCode}
        collapsed={footerCollapsed}
      />
      <span className="flex min-w-0 items-center gap-inline">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground">
          {initial}
        </span>
        {!footerCollapsed ? (
          <span className="truncate text-sm text-foreground" title={userLabel}>
            {userLabel}
          </span>
        ) : null}
      </span>
      {/* Icon actions stay reachable in the collapsed rail too. */}
      <span className={`flex items-center gap-tight ${footerCollapsed ? 'flex-col' : ''}`}>
        <ThemeToggle theme={theme} onFlip={setTheme} messages={c.theme} />
        {viewPublic}
        {signOut}
      </span>
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Mobile top bar (<768px). Inert while the drawer is open so focus can't
          escape the modal (WCAG 2.4.3 / APG modal-dialog). */}
      <header
        inert={drawerOpen || undefined}
        className="sticky top-0 z-30 flex items-center gap-inline border-b border-border bg-popover px-field py-inline md:hidden"
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          className="flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-muted active:scale-[0.98]"
        >
          <i aria-hidden className="pi pi-bars" style={{ fontSize: 20 }} />
        </button>
        <BrandMark className="h-6 w-auto text-foreground" />
        <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
      </header>

      {/* Desktop sidebar — flush, bordered, collapsible rail */}
      <aside
        className={`hidden shrink-0 flex-col gap-group border-r border-border bg-popover py-card transition-[width] md:flex ${
          railCollapsed ? 'w-[64px] px-inline' : 'w-60 px-card'
        }`}
      >
        {brand}
        <nav aria-label="Primary">
          <NavLinks
            items={items}
            collapsed={railCollapsed}
            nav={messages.nav}
            pages={messages.developerNav}
            newTab={c.switcher.opensNewTab}
          />
        </nav>
        {renderFooter(railCollapsed)}
      </aside>

      {/* Mobile drawer + backdrop */}
      {drawerOpen ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-background/80 md:hidden"
        />
      ) : null}
      <aside
        ref={drawerRef}
        className={`fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-[320px] flex-col gap-group overflow-y-auto border-r border-border bg-popover p-card transition-transform md:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Primary"
        inert={!drawerOpen || undefined}
      >
        <div className="flex items-center gap-inline px-inline">
          <BrandMark className="h-6 w-auto text-foreground" />
          <span className="text-sm font-semibold text-foreground">{PRODUCT_NAME}</span>
          <AppSwitcher messages={c.switcher} inDrawer />
        </div>
        <nav>
          <NavLinks
            items={items}
            collapsed={false}
            nav={messages.nav}
            pages={messages.developerNav}
            newTab={c.switcher.opensNewTab}
            onNavigate={() => setDrawerOpen(false)}
          />
        </nav>
        {renderFooter(false)}
      </aside>

      <main inert={drawerOpen || undefined} className="min-w-0 flex-1 bg-background">
        {children}
      </main>
    </div>
  );
}
