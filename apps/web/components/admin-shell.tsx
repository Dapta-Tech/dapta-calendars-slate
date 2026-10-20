'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavItemActive, type BookingMessages } from '@slate/shared';
import { adminNav, platformNavHref, type NavIcon, type NavItem, type SubNavItem } from '@/lib/admin-nav';
import { AccountSwitcher, type AccountOption } from '@/components/account-switcher';
import { AppSwitcher } from '@/components/app-switcher';
import { BrandMark, BrandWordmark } from '@/components/brand/brand';
import { McpLogos } from '@/components/mcp-logos';
import { ProfileMenu, type ProfileUser } from '@/components/profile-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { AnchoredMenu } from '@/components/ui/anchored-menu';
import type { Theme } from '@/lib/theme';

type AdminMessages = BookingMessages['admin'];

/** The admin shell, matched to the dForms rail so the two products read as one
 *  family: a flush 240px rail on the `sidebar` ground (one tonal step off the
 *  page, right border, never a floating card) pinned to the viewport with its
 *  own scroll; the product wordmark, then the account card, then a flat nav in
 *  the original order (see `lib/admin-nav.ts`) whose current row carries a
 *  wash and an accent bar; at the foot, the theme switch and the person's menu.
 *  A desktop collapse rail (cookie-persisted, no FOUC) and a <768px off-canvas
 *  drawer with a top bar. Every popup in the rail is an `AnchoredMenu`, since
 *  the rail scrolls and would clip it. Tokens only (no raw hex); R22 press and
 *  hover feedback; R27/R28. */

const NAV_COLLAPSED_KEY = 'slate.nav.collapsed';

/** The platform door's address (see `adminNav`), tagged; null on a fork. Read in
 *  full so Next inlines the build's value. */
const PLATFORM_HREF = platformNavHref(process.env.NEXT_PUBLIC_PLATFORM_URL);

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
  agents: 'pi-microchip-ai',
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
    'relative flex items-center gap-field rounded-md text-sm transition-colors active:scale-[0.99]',
    collapsed ? 'mx-auto h-11 w-11 justify-center gap-0 px-0' : 'min-h-control w-full px-field py-field text-left',
    state === 'active'
      ? `bg-muted font-medium text-foreground ${ACTIVE_BAR}`
      : state === 'parent'
        ? 'font-medium text-foreground hover:bg-muted'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  ].join(' ');
}

/**
 * The current row's 2px accent bar, as on the dForms rail. The `bg-muted` wash
 * alone cannot mark "you are here": it is about 1.2:1 against the rail, well
 * under the 3:1 WCAG 1.4.11 asks of a state indicator. The wash does the
 * scanning work; the bar, on `primary-edge`, does the identifying. Two signals,
 * so neither has to carry the whole job.
 */
const ACTIVE_BAR =
  'before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary-edge before:content-[""]';

/**
 * A rail item with pages under it (MCP). One `<button>` in both rail widths:
 *
 *  - Wide rail and drawer: a disclosure. The pages show indented below it, and
 *    open on their own whenever the current route is one of them.
 *  - Collapsed rail: a menu button. The pages open in a flyout beside the icon
 *    (WAI-ARIA menu button: focus lands on the first page, the arrow keys, Home
 *    and End move, Escape or a click elsewhere closes and hands focus back).
 *
 * The flyout is an `AnchoredMenu`, portalled out of the rail: the rail scrolls
 * (`overflow-y-auto`), which would clip a panel hung beside a 64px column.
 */
function NavGroup({
  item,
  pages,
  collapsed,
  label,
  labels,
  motionPaused,
  onNavigate,
}: {
  item: NavItem;
  pages: readonly SubNavItem[];
  collapsed: boolean;
  label: string;
  labels: AdminMessages['developerNav'];
  /** Nobody can see this copy of the rail right now (the closed drawer). */
  motionPaused?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const inside = isNavItemActive(pathname, item.href);
  const [open, setOpen] = useState(inside);
  const [flyout, setFlyout] = useState(false);
  // The rotating logos hold still under the pointer and under keyboard focus
  // (see McpLogos): nobody should have to read a label beside a moving target.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // The menu keys (arrows, Home, End, Tab, Escape), a click elsewhere and focus
  // handed back are all AnchoredMenu's.
  const closeFlyout = useCallback(() => setFlyout(false), []);

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

  const state = !inside ? 'idle' : collapsed || !open ? 'active' : 'parent';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`nav-${item.key}`}
        onClick={() => (collapsed ? setFlyout((v) => !v) : setOpen((v) => !v))}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-haspopup={collapsed ? 'menu' : undefined}
        aria-expanded={collapsed ? flyout : open}
        aria-controls={!collapsed && open ? listId : undefined}
        title={collapsed ? label : undefined}
        className={navRowClass(collapsed, state)}
      >
        <Icon name={item.icon} paused={hovered || focused || motionPaused} />
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
                    'relative flex min-h-control items-center rounded-md py-inline pl-11 pr-field text-sm transition-colors active:scale-[0.99]',
                    active
                      ? `bg-muted font-medium text-foreground ${ACTIVE_BAR}`
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

      <AnchoredMenu
        anchorRef={triggerRef}
        open={collapsed && flyout}
        onClose={closeFlyout}
        label={label}
        side="right"
        width={208}
        autoFocus
        className="flex flex-col overflow-hidden py-tight"
        testId={`nav-${item.key}-flyout`}
      >
        {/* The group's name, for the eye: the icon alone said nothing. */}
        <p aria-hidden className="px-field py-tight text-2xs font-medium uppercase tracking-wide text-faint">
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
                closeFlyout();
                onNavigate?.();
              }}
              className={`flex min-h-control w-full items-center gap-inline px-field text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted ${
                active ? 'bg-muted font-medium text-foreground' : 'text-foreground'
              }`}
            >
              <i
                aria-hidden
                className={`pi ${page.icon} ${active ? 'text-foreground' : 'text-muted-foreground'}`}
                style={{ fontSize: 14 }}
              />
              <span className="min-w-0 flex-1 truncate">{labels[page.key]}</span>
            </Link>
          );
        })}
      </AnchoredMenu>
    </>
  );
}

function NavLinks({
  items,
  collapsed,
  nav,
  pages,
  newTab,
  motionPaused,
  onNavigate,
}: {
  items: readonly NavItem[];
  collapsed: boolean;
  nav: AdminMessages['nav'];
  /** Labels of the pages under MCP. */
  pages: AdminMessages['developerNav'];
  /** "(opens in a new tab)", read out after an external item's label. */
  newTab: string;
  /** This copy of the rail is off screen (the closed drawer): hold the logos still. */
  motionPaused?: boolean;
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
                motionPaused={motionPaused}
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

// One identity contract for the shell and the profile menu it renders.
type ShellUser = ProfileUser;

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
  const items = adminNav({ isAdmin, docsHref, platformHref: PLATFORM_HREF });
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
  // An Escape a rail menu already used (it calls preventDefault) closes only
  // that menu: the drawer under it stays open.
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    if (drawerOpen) drawerRef.current?.querySelector<HTMLElement>('a,button')?.focus();
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const brand = (
    // px-field matches the nav rows' own padding, so the wordmark's left edge
    // lands on the column of the nav icons below it.
    <div className={`flex items-center gap-inline ${railCollapsed ? 'flex-col px-0' : 'px-field'}`}>
      {/* Inside the app the shell already says Dapta, so the rail carries the
          product wordmark alone, as the dForms rail does. Collapsed to 64px,
          only the mark fits. */}
      {railCollapsed ? (
        <BrandMark className="h-6 w-auto text-foreground" labelled />
      ) : (
        <BrandWordmark className="h-6 w-auto text-foreground" labelled />
      )}
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

  // Under the wordmark and above the nav, as the dForms rail has its workspace
  // card: which account every link below belongs to. Only operator staff have
  // a list to pick from, so for everyone else it renders nothing.
  const renderAccount = (accountCollapsed: boolean) => (
    <AccountSwitcher
      accounts={accounts}
      hasMore={accountsHasMore}
      currentAccountId={currentAccountId}
      fallbackLabel={user?.accountCode}
      collapsed={accountCollapsed}
    />
  );

  // The foot of the rail, as on dForms: the theme switch on its own row (a 44px
  // target), then the person: initial, name, email and a menu with the public
  // page and Sign out. The mobile drawer is always full-width, so its footer
  // renders expanded whatever the DESKTOP rail does, hence a param.
  //
  // Pinned to the bottom of its scrolling rail, so Sign out stays in view when
  // the nav is taller than the screen, as it is in the 360px drawer with the MCP
  // group open. It reaches down over the rail's bottom padding (`-mb-card
  // pb-card`) on the rail's own ground, so rows scrolling under it disappear
  // behind it instead of showing through the gap. The inset is `-bottom-card`,
  // not `bottom-0`: a sticky box is kept inside its scroller's padding, and
  // `bottom-0` would lift it out of the corner it already sits in.
  const renderFooter = (footerCollapsed: boolean, onNavigate?: () => void) => (
    <div
      className={`sticky -bottom-card -mb-card mt-auto flex flex-col gap-tight border-t border-border bg-sidebar pb-card pt-field ${
        footerCollapsed ? 'items-center' : ''
      }`}
    >
      <span className="flex items-center">
        <ThemeToggle theme={theme} onFlip={setTheme} messages={c.theme} />
      </span>
      <ProfileMenu
        user={user}
        collapsed={footerCollapsed}
        messages={{
          label: c.accountMenu,
          viewPublic: c.viewPublic,
          signOut: c.signOut,
          opensNewTab: c.switcher.opensNewTab,
        }}
        onNavigate={onNavigate}
      />
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Mobile top bar (<768px). Inert while the drawer is open so focus can't
          escape the modal (WCAG 2.4.3 / APG modal-dialog). */}
      <header
        inert={drawerOpen || undefined}
        className="sticky top-0 z-30 flex items-center gap-inline border-b border-border bg-sidebar px-field py-inline md:hidden"
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
        {/* Under 360px the menu button plus the wordmark crowds the bar, so the
            mark takes over. Done in CSS (no flash, no resize listener); only
            the visible one is displayed, so one name reaches the a11y tree.
            The classes sit on wrappers, not on the marks: a fork's fallback
            (chip and name) does not take a className, and would show twice. */}
        <span className="hidden min-[360px]:flex">
          <BrandWordmark className="h-6 w-auto text-foreground" labelled />
        </span>
        <span className="flex min-[360px]:hidden">
          <BrandMark className="h-6 w-auto text-foreground" labelled />
        </span>
      </header>

      {/* Desktop sidebar: flush, bordered, collapsible. Pinned to the viewport
          (`sticky h-dvh`) rather than stretched with the page, so the footer
          with the account and Sign out never sits a long page below the fold;
          `overflow-y-auto` keeps it usable when the nav outgrows a short
          window (which is why every rail popup is an AnchoredMenu). */}
      <aside
        className={`hidden shrink-0 flex-col gap-group border-r border-border bg-sidebar py-card transition-[width] md:sticky md:top-0 md:flex md:h-dvh md:overflow-y-auto ${
          railCollapsed ? 'w-[64px] px-inline' : 'w-60 px-card'
        }`}
      >
        {brand}
        {renderAccount(railCollapsed)}
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
        className={`fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-[320px] flex-col gap-group overflow-y-auto border-r border-border bg-sidebar p-card transition-transform md:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-label="Primary"
        // Containment is `inert` on everything else (the top bar and <main>),
        // not aria-modal: the rail's menus are portalled to the end of <body>,
        // and aria-modal would hide them from assistive tech here and nowhere
        // else. With the top bar and <main> inert and the desktop rail hidden,
        // the drawer and the menu it opened are all that can be reached.
        inert={!drawerOpen || undefined}
      >
        {/* The drawer is 82vw capped at 320px, so the wordmark always fits. */}
        <div className="flex items-center gap-inline px-field">
          <BrandWordmark className="h-6 w-auto text-foreground" labelled />
          <AppSwitcher messages={c.switcher} />
        </div>
        {renderAccount(false)}
        <nav>
          <NavLinks
            items={items}
            collapsed={false}
            nav={messages.nav}
            pages={messages.developerNav}
            newTab={c.switcher.opensNewTab}
            motionPaused={!drawerOpen}
            onNavigate={() => setDrawerOpen(false)}
          />
        </nav>
        {renderFooter(false, () => setDrawerOpen(false))}
      </aside>

      <main inert={drawerOpen || undefined} className="min-w-0 flex-1 bg-background">
        {children}
      </main>
    </div>
  );
}
