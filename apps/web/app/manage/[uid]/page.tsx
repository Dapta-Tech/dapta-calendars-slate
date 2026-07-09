import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { formatSlotDateTime, getMessages, t } from '@slate/shared';
import { getManageView, getAvailability } from '@/lib/api';
import { ManageActions } from './manage-actions';

// The emailed manage link lands here: /manage/:uid?token=… — token-gated view
// with reschedule + cancel. Makes the confirmation email's manage URL live.
export default async function ManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ uid: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { uid } = await params;
  const { token } = await searchParams;
  if (!token) notFound();

  const booking = await getManageView(uid, token);
  if (!booking) notFound();

  const tz = booking.attendee.timeZone;
  // Public emailed link — no admin cookie; take the locale from the browser.
  const accept = (await headers()).get('accept-language') ?? '';
  const m = getMessages(accept.toLowerCase().startsWith('es') ? 'es' : 'en').manage;
  const statusText = (s: string) =>
    s === 'pending' ? m.statusPending : s === 'cancelled' ? m.statusCancelled : s === 'rejected' ? m.statusRejected : s;

  // Engine-backed reschedule options (G7): only real, bookable slots.
  const now = new Date();
  const avail =
    booking.status === 'accepted' && booking.reschedule
      ? await getAvailability({
          accountCode: booking.reschedule.accountCode,
          handle: booking.reschedule.handle,
          slug: booking.reschedule.slug,
          from: now.toISOString(),
          to: new Date(now.getTime() + 21 * 86_400_000).toISOString(),
        })
      : null;

  // Granular gate: an accepted booking is manageable only while it's in the
  // future (can't reschedule/cancel a meeting that already happened).
  const isPast = new Date(booking.startUtc).getTime() <= now.getTime();
  const canManage = booking.status === 'accepted' && !isPast;

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{booking.title}</h1>
        <p className="text-muted-foreground">{formatSlotDateTime(booking.startUtc, tz)}</p>
        <p className="text-sm text-muted-foreground">
          {m.withLabel} {booking.host.name ?? booking.attendee.name} · {booking.attendee.email}
        </p>
        {booking.status !== 'accepted' ? (
          <p className="text-sm text-destructive">{t(m.bookingIs, { status: statusText(booking.status) })}</p>
        ) : null}
      </header>

      {canManage ? (
        <ManageActions uid={uid} token={token} slots={avail?.slots ?? []} timeZone={tz} messages={m} />
      ) : (
        <p className="rounded-md border border-border bg-card p-4 text-muted-foreground">
          {isPast && booking.status === 'accepted' ? m.alreadyTookPlace : m.cannotChange}
        </p>
      )}
    </main>
  );
}
