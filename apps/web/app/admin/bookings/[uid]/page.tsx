import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { ADMIN_BOOKINGS_PATH, getMessages, safeTimeZone, t } from '@slate/shared';
import { BOOKING_UTM_KEYS, type BookingUtm } from '@slate/types';
import { adminApi, ApiError, type BookingGuestDetails } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';
import { CancelAction, PendingActions } from '../booking-actions';
import { BookingStatusPill, bookingSection, formatBookingStart, type BookingsMessages } from '../booking-parts';

export const dynamic = 'force-dynamic';

/**
 * One booking, on its own page: where the host's request email sends its
 * "Confirm or decline" button (`adminBookingPath`), and where each row of the
 * bookings list leads. It reads the booking by uid, so it opens whatever the
 * list's first page leaves out, offers the same action the list would, shows
 * who booked and what they answered (to the booking's host and co-hosts, as
 * the host's email does), and the campaign the booking came from when it has
 * one. A uid that is not this account's is a 404, the same as one that does
 * not exist.
 *
 * Signed out, the admin gate sends the person through the login with this page
 * as the return target, so they land back here.
 */
export default async function BookingPage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const locale = await getLocale();
  const [booking, me] = await Promise.all([
    adminApi.getBooking(uid, locale).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }),
    adminApi.me(),
  ]);
  if (!booking) notFound();

  // safeTimeZone: a corrupt stored zone must never crash the page (QA fix 1).
  const tz = safeTimeZone(me?.timeZone);
  const m = getMessages(locale).admin.bookings;
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
        <span className="font-medium">{formatBookingStart(booking.startUtc, tz, locale)}</span>
        <BookingStatusPill status={booking.status} m={m} />
      </section>
      {/* Which zone the short "MST"-style label above refers to (QA2 fix 8c). */}
      <p className="mt-field text-sm text-muted-foreground">{t(m.timesShownIn, { tz: tz.replaceAll('_', ' ') })}</p>
      <Guest guest={booking.guest} m={m} />
      <Campaign utm={booking.utm} m={m} />
    </div>
  );
}

/**
 * Who booked and what they answered: the host email's "Guest details" and
 * "Their answers", built by the API with the same code (the event's questions
 * in its order, labelled as the host wrote them, then the notes). Nothing at
 * all when the API sends none: the caller is not the booking's host or a
 * co-host, or the booking has no invitee. Everything but the labels was typed
 * by a visitor: React escapes it as text, never a link.
 */
function Guest({ guest, m }: { guest: BookingGuestDetails | null | undefined; m: BookingsMessages }) {
  if (!guest) return null;
  const who = (
    [
      [m.guestName, guest.name],
      [m.guestEmail, guest.email],
      [m.guestPhone, guest.phone ?? ''],
      [m.guestOthers, guest.others.join(', ')],
    ] as const
  ).filter(([, value]) => value);
  return (
    <section aria-labelledby="booking-guest" className="mt-section" data-testid="booking-guest">
      <h2 id="booking-guest" className="mb-field text-sm font-semibold text-muted-foreground">
        {m.guestTitle}
      </h2>
      <Details rows={who} />
      {guest.answers.length > 0 ? (
        <>
          <h3 className="mb-field mt-group text-sm font-semibold text-muted-foreground">{m.guestAnswersTitle}</h3>
          <Details rows={guest.answers.map((a) => [a.label, a.value] as const)} />
        </>
      ) : null}
    </section>
  );
}

/** Label and value pairs in a card; a value keeps the lines it was typed with. */
function Details({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-group gap-y-inline rounded-md border border-border bg-card p-card text-sm">
      {rows.map(([label, value], i) => (
        <Fragment key={i}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 whitespace-pre-line break-words font-medium">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * The campaign the booking came from: each `utm_*` it kept, under its own key
 * (the name the host put on the link, never translated), in the order a UTM
 * link lists them. Nothing at all when the booking has none, which is every
 * booking made from a link without UTMs and every one made before they were
 * kept. The values came on a public link: React escapes them as text.
 */
function Campaign({ utm, m }: { utm: BookingUtm | null | undefined; m: BookingsMessages }) {
  const rows = BOOKING_UTM_KEYS.flatMap((key) => (utm?.[key] ? [[key, utm[key]] as const] : []));
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="booking-campaign" className="mt-section" data-testid="booking-campaign">
      <h2 id="booking-campaign" className="mb-field text-sm font-semibold text-muted-foreground">
        {m.campaignTitle}
      </h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-group gap-y-inline rounded-md border border-border bg-card p-card text-sm">
        {rows.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="font-mono text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-field text-sm text-muted-foreground">{m.campaignHint}</p>
    </section>
  );
}
