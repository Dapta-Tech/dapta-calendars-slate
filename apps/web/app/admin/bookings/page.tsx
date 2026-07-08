import { adminApi } from '@/lib/admin-api';
import { CancelAction, PendingActions } from './booking-actions';

export const dynamic = 'force-dynamic';

type Row = { uid: string; status: string; title: string; startUtc: string };

export default async function BookingsPage() {
  const { items } = await adminApi.listBookings('limit=200').catch(() => ({ items: [] }));
  const now = Date.now();
  const pending = items.filter((b) => b.status === 'pending');
  const upcoming = items.filter((b) => b.status === 'accepted' && new Date(b.startUtc).getTime() > now);
  const past = items.filter(
    (b) => b.status !== 'pending' && !(b.status === 'accepted' && new Date(b.startUtc).getTime() > now),
  );

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Bookings</h1>

      {pending.length > 0 ? (
        <Section title={`Pending confirmation (${pending.length})`} rows={pending} action="pending" />
      ) : null}
      <Section title={`Upcoming (${upcoming.length})`} rows={upcoming} action="cancel" />
      <Section title={`Past & cancelled (${past.length})`} rows={past} muted />
    </div>
  );
}

function Section({
  title,
  rows,
  muted,
  action,
}: {
  title: string;
  rows: Row[];
  muted?: boolean;
  action?: 'pending' | 'cancel';
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((b) => (
            <li
              key={b.uid}
              className={`flex items-center justify-between rounded-md border border-border bg-card p-4 ${
                muted ? 'opacity-70' : ''
              }`}
            >
              <span className="flex flex-col">
                <span className="font-medium">{b.title}</span>
                <span className="text-sm text-muted-foreground">
                  {new Intl.DateTimeFormat('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  }).format(new Date(b.startUtc))}
                </span>
              </span>
              <div className="flex items-center gap-3">
                {action === 'pending' ? <PendingActions uid={b.uid} /> : null}
                {action === 'cancel' ? <CancelAction uid={b.uid} /> : null}
                <span
                  className={`rounded-sm px-2 py-1 text-xs ${
                    b.status === 'accepted'
                      ? 'bg-primary text-primary-foreground'
                      : b.status === 'pending'
                        ? 'bg-secondary text-secondary-foreground'
                        : b.status === 'cancelled' || b.status === 'rejected'
                          ? 'bg-destructive text-destructive-foreground'
                          : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {b.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
