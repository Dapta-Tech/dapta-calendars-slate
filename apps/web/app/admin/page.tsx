import Link from 'next/link';
import { adminApi } from '@/lib/admin-api';
import { CopyLink } from '@/components/copy-link';

export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const me = await adminApi.me().catch(() => null);
  const [eventTypes, bookings, teams] = await Promise.all([
    adminApi.listEventTypes().catch(() => []),
    adminApi.listBookings('limit=100').catch(() => ({ items: [] })),
    adminApi.listTeams().catch(() => []),
  ]);
  const upcoming = bookings.items.filter(
    (b) => b.status === 'accepted' && new Date(b.startUtc).getTime() > Date.now(),
  );
  const publicUrl = me?.handle ? `/${me.accountCode}/${me.handle}` : null;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">
        Welcome{me?.displayName ? `, ${me.displayName.split(' ')[0]}` : ''}
      </h1>
      <p className="mb-8 text-muted-foreground">Your scheduling at a glance.</p>

      {publicUrl ? (
        <div className="mb-8 flex flex-col gap-2 rounded-md border border-border bg-card p-5">
          <span className="text-sm text-muted-foreground">Your booking link</span>
          <CopyLink path={publicUrl} />
        </div>
      ) : (
        <div className="mb-8 rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
          Set a handle in{' '}
          <Link href="/admin/settings/booking-page" className="text-primary hover:underline">
            your booking page
          </Link>{' '}
          to get a shareable link.
        </div>
      )}

      <div className="mb-8 grid grid-cols-3 gap-4">
        <Stat label="Event types" value={eventTypes.length} href="/admin/event-types" />
        <Stat label="Upcoming bookings" value={upcoming.length} href="/admin/bookings" />
        <Stat label="Teams" value={teams.length} href="/admin/teams" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Shortcut href="/admin/event-types" title="Create an event type" desc="Define a bookable meeting." />
        <Shortcut href="/admin/availability" title="Set your availability" desc="Weekly hours + date overrides." />
        <Shortcut href="/admin/settings/booking-page" title="Style your booking page" desc="Brand + 9-axis studio." />
        <Shortcut href="/admin/settings/developer" title="API keys & webhooks" desc="Integrate agents & automations." />
      </div>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-md border border-border bg-card p-5 transition-transform hover:border-primary active:scale-[0.99]"
    >
      <span className="text-3xl font-semibold">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </Link>
  );
}

function Shortcut({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-md border border-border bg-card p-5 transition-transform hover:border-primary active:scale-[0.99]"
    >
      <span className="font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{desc}</span>
    </Link>
  );
}
