import type { ReactNode } from 'react';
import Link from 'next/link';
import { adminApi } from '@/lib/admin-api';

const NAV = [
  { href: '/admin', label: 'Home', icon: '⌂' },
  { href: '/admin/event-types', label: 'Event Types', icon: '◷' },
  { href: '/admin/availability', label: 'Availability', icon: '▦' },
  { href: '/admin/bookings', label: 'Bookings', icon: '☑' },
  { href: '/admin/teams', label: 'Teams', icon: '👥' },
  { href: '/admin/connections', label: 'Connections', icon: '🔗' },
  { href: '/admin/settings/booking-page', label: 'Booking Page', icon: '🎨' },
  { href: '/admin/settings/developer', label: 'Developer', icon: '⌨' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let me: Awaited<ReturnType<typeof adminApi.me>> | null = null;
  try {
    me = await adminApi.me();
  } catch {
    me = null;
  }

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-card p-4">
        <div className="mb-4 flex items-center gap-2 px-2">
          <span className="rounded-md bg-primary px-2 py-0.5 text-sm font-semibold text-primary-foreground">
            Slate
          </span>
          <span className="text-sm text-muted-foreground">admin</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="w-5 text-center text-muted-foreground">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-border px-2 pt-3 text-xs text-muted-foreground">
          <span>{me?.displayName ?? 'Not signed in'}</span>
          {me?.handle ? (
            <Link href={`/${me.accountCode}/${me.handle}`} className="text-primary hover:underline">
              View public page →
            </Link>
          ) : null}
          <span className="opacity-60">dev auth stub</span>
        </div>
      </aside>
      <main className="min-w-0 flex-1 bg-background">{children}</main>
    </div>
  );
}
