import { notFound } from 'next/navigation';
import { ADMIN_BOOKINGS_PATH, getMessages, safeTimeZone, t } from '@slate/shared';
import { adminApi, ApiError } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';
import { CancelAction, PendingActions } from '../booking-actions';
import { BookingStatusPill, bookingSection, formatBookingStart } from '../booking-parts';

export const dynamic = 'force-dynamic';

/**
 * One booking, on its own page: where the host's request email sends its
 * "Confirm or decline" button (`adminBookingPath`). It reads the booking by
 * uid, so it opens whatever the list's first page leaves out, and it offers
 * the same action the list would. A uid that is not this account's is a 404,
 * the same as one that does not exist.
 *
 * Signed out, the admin gate sends the person through the login with this page
 * as the return target, so they land back here.
 */
export default async function BookingPage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const [booking, me] = await Promise.all([
    adminApi.getBooking(uid).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }),
    adminApi.me(),
  ]);
  if (!booking) notFound();

  // safeTimeZone: a corrupt stored zone must never crash the page (QA fix 1).
  const tz = safeTimeZone(me?.timeZone);
  const m = getMessages(await getLocale()).admin.bookings;
  const section = bookingSection(booking, Date.now());

  return (
    <div className="mx-auto max-w-[1520px] px-gutter pb-gutter-y sm:px-gutter-wide">
      <FormHeader
        backHref={ADMIN_BOOKINGS_PATH}
        backLabel={m.title}
        title={booking.title}
        gutter="responsive"
        actions={
          section === 'pending' ? (
            <PendingActions uid={booking.uid} m={m} />
          ) : section === 'upcoming' ? (
            <CancelAction uid={booking.uid} m={m} />
          ) : undefined
        }
      />
      <section
        className={`flex flex-wrap items-center justify-between gap-field rounded-md border border-border bg-card p-card ${
          section === 'past' ? 'opacity-70' : ''
        }`}
      >
        <span className="font-medium">{formatBookingStart(booking.startUtc, tz)}</span>
        <BookingStatusPill status={booking.status} m={m} />
      </section>
      {/* Which zone the short "MST"-style label above refers to (QA2 fix 8c). */}
      <p className="mt-field text-sm text-muted-foreground">{t(m.timesShownIn, { tz: tz.replaceAll('_', ' ') })}</p>
    </div>
  );
}
