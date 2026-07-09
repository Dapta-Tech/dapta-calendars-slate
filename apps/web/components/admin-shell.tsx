'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Design-parity admin shell — mirrors the old Angular app-shell: a flush 240px
 *  sidebar (bg-popover, right border, never a floating card), a flat 6-item nav
 *  in the original order, a bottom user footer, a desktop collapse rail
 *  (localStorage-persisted), and a <768px off-canvas drawer with a hamburger
 *  top bar. Tokens only (no raw hex); R22 press/hover feedback; R27/R28. */

type IconName = 'home' | 'calendar' | 'clock' | 'ticket' | 'users' | 'cog';

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  /** Active when the path starts with any of these (in addition to href). */
  match?: string[];
}

// Same information architecture + order as the old app: Home, Bookings,
// Availability, Event Types, Teams, Settings (Settings is a single item with
// its own sub-nav; Calendars lives under it at /admin/connections).
const NAV: NavItem[] = [
  { label: 'Home', href: '/admin', icon: 'home' },
  { label: 'Bookings', href: '/admin/bookings', icon: 'calendar' },
  { label: 'Availability', href: '/admin/availability', icon: 'clock' },
  { label: 'Event Types', href: '/admin/event-types', icon: 'ticket' },
  { label: 'Teams', href: '/admin/teams', icon: 'users' },
  { label: 'Settings', href: '/admin/settings', icon: 'cog', match: ['/admin/settings', '/admin/connections'] },
];

const NAV_COLLAPSED_KEY = 'slate.nav.collapsed';

function Icon({ name, className }: { name: IconName; className?: string }) {
  const common = {
    className,
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
        </svg>
      );
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="4.5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 2.5v4M16 2.5v4" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case 'ticket':
      return (
        <svg {...common}>
          <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z" />
          <path d="M14 6v12" strokeDasharray="2 2" />
        </svg>
      );
    case 'users':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
          <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9" />
        </svg>
      );
    case 'cog':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 8 2.6h.1A1.6 1.6 0 0 0 9 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
        </svg>
      );
  }
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/admin') return pathname === '/admin';
  const targets = item.match ?? [item.href];
  return targets.some((t) => pathname === t || pathname.startsWith(`${t}/`) || pathname === t);
}

function NavLinks({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = isActive(pathname, item);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex min-h-[44px] items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors active:scale-[0.99]',
                collapsed ? 'justify-center gap-0' : '',
                active
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              ].join(' ')}
            >
              <Icon name={item.icon} />
              {!collapsed ? <span>{item.label}</span> : null}
            </Link>
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

export function AdminShell({ user, children }: { user: ShellUser | null; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Restore + persist the desktop rail preference.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
    } catch {
      /* storage disabled */
    }
  }, []);
  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Lock body scroll + close on Escape while the mobile drawer is open (R28).
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const initial = (user?.displayName?.trim()?.charAt(0) || 'A').toUpperCase();
  const userLabel = user?.displayName ?? 'Not signed in';

  const brand = (
    <div className={`flex items-center gap-2 px-2 ${collapsed ? 'flex-col px-0' : ''}`}>
      <span className="rounded-md bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">S</span>
      {!collapsed ? <span className="text-sm font-semibold text-foreground">Slate</span> : null}
      <button
        type="button"
        onClick={toggleCollapse}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={collapsed ? 'Expand' : 'Collapse'}
        className={`hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98] md:inline-flex ${collapsed ? '' : 'ml-auto'}`}
      >
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          {collapsed ? <path d="m9 6 6 6-6 6" /> : <path d="m15 6-6 6 6 6" />}
        </svg>
      </button>
    </div>
  );

  const footer = (
    <div
      className={`mt-auto grid items-center gap-2 border-t border-border pt-3 ${
        collapsed ? 'grid-cols-1 justify-items-center' : 'grid-cols-[30px_1fr]'
      }`}
    >
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground">
        {initial}
      </span>
      {!collapsed ? (
        <span className="flex flex-col overflow-hidden">
          <span className="truncate text-sm text-foreground" title={userLabel}>
            {userLabel}
          </span>
          {user?.handle ? (
            <Link href={`/${user.accountCode}/${user.handle}`} className="truncate text-xs text-primary hover:underline">
              View public page →
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground opacity-60">dev auth stub</span>
          )}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Mobile top bar (<768px) */}
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-popover px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          className="flex h-11 w-11 items-center justify-center rounded-md text-foreground hover:bg-muted active:scale-[0.98]"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="rounded-md bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">S</span>
        <span className="text-sm font-semibold">Slate</span>
      </header>

      {/* Desktop sidebar — flush, bordered, collapsible rail */}
      <aside
        className={`hidden shrink-0 flex-col gap-6 border-r border-border bg-popover p-4 transition-[width] md:flex ${
          collapsed ? 'w-[68px]' : 'w-60'
        }`}
      >
        {brand}
        <nav aria-label="Primary">
          <NavLinks collapsed={collapsed} />
        </nav>
        {footer}
      </aside>

      {/* Mobile drawer + backdrop */}
      {drawerOpen ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[82vw] max-w-[320px] flex-col gap-6 overflow-y-auto border-r border-border bg-popover p-4 transition-transform md:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Primary"
        aria-hidden={!drawerOpen}
      >
        <div className="flex items-center gap-2 px-2">
          <span className="rounded-md bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">S</span>
          <span className="text-sm font-semibold text-foreground">Slate</span>
        </div>
        <nav>
          <NavLinks collapsed={false} onNavigate={() => setDrawerOpen(false)} />
        </nav>
        {footer}
      </aside>

      <main className="min-w-0 flex-1 bg-background">{children}</main>
    </div>
  );
}
