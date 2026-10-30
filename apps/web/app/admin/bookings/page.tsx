import Link from 'next/link';
import { adminBookingPath, getMessages, t, safeTimeZone } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { PageHeader } from '@/components/ui/page-header';
import { CancelAction, PendingActions } from './booking-actions';
import {
  BookingStatusPill,
  bookingSection,
  formatBookingStart,
  type BookingRowData as Row,
  type BookingsMessages,
} from './booking-parts';
import { LegacyBookingLink } from './legacy-booking-link';

export const dynamic = 'force-dynamic';

export default async function BookingsPage() {
  const [{ items }, me] = await Promise.all([
    adminApi.listBookings('limit=200'),
    adminApi.me(),
  ]);
  // safeTimeZone: a corrupt stored zone must never crash the whole page (QA fix 1).
  const tz = safeTimeZone(me?.timeZone);
  const m = getMessages(await getLocale()).admin.bookings;
  const now = Date.now();
  const pending = items.filter((b) => bookingSection(b, now) === 'pending');
  const upcoming = items.filter((b) => bookingSection(b, now) === 'upcoming');
  const past = items.filter((b) => bookingSection(b, now) === 'past');

  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      {/* An email sent before the booking had its own page linked here with
          the uid in the fragment: this moves it to that page. */}
      <LegacyBookingLink />
      <PageHeader
        title={m.title}
        action={
          <Link
            href="/admin/bookings/new"
            className="inline-flex min-h-control items-center rounded-md bg-primary px-card py-field text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {m.newBooking}
          </Link>
        }
      />
      {/* Which zone the short "MST"-style labels below refer to (QA2 fix 8c). */}
      <p className="-mt-group mb-section text-sm text-muted-foreground">
        {t(m.timesShownIn, { tz: tz.replaceAll('_', ' ') })}
      </p>

      {pending.length > 0 ? (
        <Section title={`${m.pendingConfirmation} (${pending.length})`} rows={pending} action="pending" timeZone={tz} m={m} />
      ) : null}
      <Section title={`${m.upcoming} (${upcoming.length})`} rows={upcoming} action="cancel" timeZone={tz} m={m} />
      <Section title={`${m.pastCancelled} (${past.length})`} rows={past} muted timeZone={tz} m={m} />
    </div>
  );
}

function Section({
  title,
  rows,
  muted,
  action,
  timeZone,
  m,
}: {
  title: string;
  rows: Row[];
  muted?: boolean;
  action?: 'pending' | 'cancel';
  timeZone: string;
  m: BookingsMessages;
}) {
  return (
    <section className="mb-section">
      <h2 className="mb-field text-sm font-semibold text-muted-foreground">{title}</h2>
      {rows.length === 0 ? (
        <div className="flex items-center gap-inline rounded-md border border-dashed border-border p-card text-sm text-muted-foreground">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4.5" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 2.5v4M16 2.5v4" />
          </svg>
          {m.nothingHere}
        </div>
      ) : (
        <ul className="flex flex-col gap-inline">
          {rows.map((b) => (
            <li
              key={b.uid}
              className={`flex items-center justify-between gap-field rounded-md border border-border bg-card p-card ${
                muted ? 'opacity-70' : ''
              }`}
            >
              {/* The booking's own page: its details, the campaign it came
                  from and the same action this row offers. */}
              <Link href={adminBookingPath(b.uid)} className="group flex min-w-0 flex-col">
                <span className="font-medium group-hover:underline">{b.title}</span>
                <span className="text-sm text-muted-foreground">{formatBookingStart(b.startUtc, timeZone)}</span>
              </Link>
              <div className="flex items-center gap-field">
                {action === 'pending' ? <PendingActions uid={b.uid} m={m} /> : null}
                {action === 'cancel' ? <CancelAction uid={b.uid} m={m} /> : null}
                <BookingStatusPill status={b.status} m={m} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
