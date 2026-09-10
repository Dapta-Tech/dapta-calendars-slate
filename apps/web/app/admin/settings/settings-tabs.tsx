'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { BookingMessages } from '@slate/shared';

type SettingsMessages = BookingMessages['admin']['settings'];

// Second-level settings nav: General · Booking Page · Members · Integrations ·
// Developer. (Calendars is a top-level nav item at /admin/connections, not a
// settings tab; a CRM is NOT one either until there is more than one of them —
// #63.) Labels resolve per-locale. Members, Integrations and Developer are
// admin/owner-only: the CRM credential is an account-level resource.
const TABS: {
  key: keyof Omit<SettingsMessages, 'title' | 'subtitle'>;
  href: string;
  adminOnly?: boolean;
}[] = [
  { key: 'general', href: '/admin/settings/general' },
  { key: 'bookingPage', href: '/admin/settings/booking-page' },
  { key: 'notifications', href: '/admin/settings/notifications', adminOnly: true },
  { key: 'members', href: '/admin/settings/members', adminOnly: true },
  { key: 'integrations', href: '/admin/settings/integrations', adminOnly: true },
  { key: 'developer', href: '/admin/settings/developer', adminOnly: true },
];

export function SettingsTabs({ messages, isAdmin }: { messages: SettingsMessages; isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    // Horizontal, scrollable settings sub-nav. Active = raised fill + medium
    // weight (DS recipe — no accent bar), matching the main sidebar nav.
    // The negative inline margin + matching padding lets the strip scroll
    // edge-to-edge at 360px instead of clipping inside the page gutter, and
    // every tab sits on the 44px step because a tab is a touch target too.
    <nav
      className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0"
      aria-label="Settings"
    >
      {TABS.filter((tab) => isAdmin || !tab.adminOnly).map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm transition-colors active:scale-[0.99]',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            {messages[tab.key]}
          </Link>
        );
      })}
    </nav>
  );
}
