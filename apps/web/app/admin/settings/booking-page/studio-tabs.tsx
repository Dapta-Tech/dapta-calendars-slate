'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The two halves of the studio: the host's own page, and the workspace brand
 * kit beside it. Same recipe as the settings sub-nav (raised fill and weight
 * for the active tab, no accent bar), on the 44px step.
 */
export function StudioTabs({ yourPage, brandKit }: { yourPage: string; brandKit: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: '/admin/settings/booking-page', label: yourPage, active: pathname === '/admin/settings/booking-page' },
    {
      href: '/admin/settings/booking-page/brand-kit',
      label: brandKit,
      active: pathname.startsWith('/admin/settings/booking-page/brand-kit'),
    },
  ];
  return (
    <nav aria-label={brandKit} className="mb-group flex gap-tight">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={[
            'inline-flex min-h-control shrink-0 items-center whitespace-nowrap rounded-md px-field text-sm transition-colors active:scale-[0.99]',
            tab.active
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          ].join(' ')}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
