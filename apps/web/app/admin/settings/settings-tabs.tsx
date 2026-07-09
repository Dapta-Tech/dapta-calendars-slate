'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Second-level settings nav (mirrors the old app's Settings sub-nav):
// General · Booking Page · Calendars · Developer.
const TABS = [
  { label: 'General', href: '/admin/settings/general' },
  { label: 'Booking Page', href: '/admin/settings/booking-page' },
  { label: 'Calendars', href: '/admin/connections' },
  { label: 'Developer', href: '/admin/settings/developer' },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    // Horizontal, scrollable settings sub-nav. Active = raised fill + medium
    // weight (DS recipe — no accent bar), matching the main sidebar nav.
    <nav className="mb-6 flex gap-1 overflow-x-auto" aria-label="Settings">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors active:scale-[0.99]',
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
