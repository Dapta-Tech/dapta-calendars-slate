import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  formatBookingLocation,
  formatDayLong,
  formatTimeRange,
  getMessages,
  readableZone,
  t,
} from '@slate/shared';
import type { BookingView } from '@slate/types';
import { getManageView, getAvailability, getProfile, getRescheduleAvailability } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { ManageActions } from './manage-actions';
import { BookingStage, BookingSummary } from '@/components/booking-page-parts';
import { BrandedShell } from '@/components/branded-shell';
import { MadeWithBadge } from '@/components/made-with-badge';

// Token-gated personal page: never indexed, and the title stays generic so no
// booking detail leaks into link previews or crawlers.
export const metadata: Metadata = {
  title: 'Manage your booking',
  robots: { index: false, follow: false },
};

/**
 * The branding the page wears: the HOST's, when the booking says who the host
 * is (a personal booking's reschedule context names their account and handle),
 * so the page an invitee reaches from their email looks like the page they
 * booked on. A team booking, or one written before the context existed, gets
 * the defaults, as a team's own pages do. A failed read costs the branding,
 * never the page.
 */
async function hostBranding(
  booking: BookingView | null,
): Promise<{ brandColor: string | null; style: Record<string, unknown> | null }> {
  const rs = booking?.reschedule;
  if (!rs || rs.kind === 'team' || !('handle' in rs)) return { brandColor: null, style: null };
  try {
    const profile = await getProfile(rs.accountCode, rs.handle);
    return {
      brandColor: profile?.member.brandColor ?? null,
      style: (profile?.member.style as Record<string, unknown> | null) ?? null,
    };
  } catch {
    return { brandColor: null, style: null };
  }
}

/**
 * The manage link no longer opens a booking. Rendered instead of throwing, and
 * instead of a bare 404, because the commonest way to get here is benign: the
 * manage token rotates on every reschedule, so the link in an EARLIER email is
 * supposed to stop working. The booking is fine; only the link is stale.
 */
async function ManageLinkInvalid() {
  const locale = await publicLocale();
  const messages = getMessages(locale);
  const m = messages.manage;
  return (
    <BrandedShell brandColor={null} style={null} className="bp-viewport">
      <main className="w-full py-10 md:px-6 md:py-12">
        <BookingStage m={messages} step="done">
          <section className="bp-card bp-notice">
            <h1 className="bp-notice-title">{m.linkInvalidTitle}</h1>
            <p className="bp-muted">{m.linkInvalidBody}</p>
          </section>
        </BookingStage>
      </main>
      <MadeWithBadge locale={locale} />
    </BrandedShell>
  );
}

// The emailed manage link lands here: /manage/:uid?token=…, a token-gated view
// with reschedule and cancel. Makes the confirmation email's manage URL live.
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

  const result = await getManageView(uid, token);
  // A booking that does not exist is a 404. A link that no longer opens one is
  // NOT: the manage token rotates on every reschedule, so an older emailed link
  // is expected to stop working, and saying so beats both a bare 404 and the
  // thrown error boundary this used to produce (#123).
  if (!result.ok) {
    if (result.reason === 'not-found') notFound();
    return <ManageLinkInvalid />;
  }
  const booking = result.booking;

  // The body is PARSED, not asserted, and a body that fails to parse is handed
  // over as it arrived rather than discarded, because it still describes a real
  // booking (#123). So render from what is actually there: `startUtc` is read
  // through `Date.parse` first, and an unreadable instant costs the time line
  // instead of throwing `RangeError` out of `Intl` and into the public error
  // boundary, which is precisely what #102 looked like on the confirmation.
  const startUtc = Number.isNaN(Date.parse(booking.startUtc ?? '')) ? null : booking.startUtc;
  const endUtc = Number.isNaN(Date.parse(booking.endUtc ?? '')) ? null : booking.endUtc;
  const attendee = booking.attendee ?? { name: '', email: '', timeZone: 'UTC' };
  const tz = attendee.timeZone || 'UTC';
  // Public emailed link, no admin cookie: take the locale from the browser.
  const locale = await publicLocale();
  const messages = getMessages(locale);
  const m = messages.manage;
  const statusText = (s: string) =>
    s === 'pending' ? m.statusPending : s === 'cancelled' ? m.statusCancelled : s === 'rejected' ? m.statusRejected : s;
  // Only render a meeting link if it's an http(s) URL: `meeting_url` is a
  // free-text column; never render a javascript:/data: value as an href.
  const meetingUrl = booking.meetingUrl && /^https?:\/\//i.test(booking.meetingUrl) ? booking.meetingUrl : null;

  // Engine-backed reschedule options (G7): only real, bookable slots, asked of
  // the route that can SEE this event type. A team event type has `team_id` and
  // no `member_id`, so the personal route's `account + member + slug` lookup
  // misses it entirely: it answered nothing, the picker rendered its empty
  // state, and a team invitee could cancel but never reschedule (#122). The
  // context says which kind it is rather than leaving the page to infer it.
  //
  // A TEAM booking then asks the BOOKING-scoped route rather than the public
  // team one (#127). The public route answers what the event offers a NEW
  // invitee, and for round-robin that is the union across hosts, while the
  // reschedule keeps the host this booking was assigned, so the union offered
  // times the write refused with a 400 the page showed as a reschedule error.
  // The booking-scoped read asks about this booking's own hosts, which is the
  // set the write validates. The personal branch is unchanged: one host, and
  // the public availability route already answers for exactly that host.
  const now = new Date();
  // Named `range`, not `window`: a binding that shadows the global `window` is a
  // trap for whoever next adds a client-side branch here.
  const range = {
    from: now.toISOString(),
    to: new Date(now.getTime() + 21 * 86_400_000).toISOString(),
  };
  const rs = booking.status === 'accepted' ? booking.reschedule : undefined;
  const [avail, branding] = await Promise.all([
    !rs
      ? null
      : rs.kind === 'team'
        ? getRescheduleAvailability({ uid, token, ...range })
        : getAvailability({ accountCode: rs.accountCode, handle: rs.handle, slug: rs.slug, ...range }),
    hostBranding(booking),
  ]);

  // Granular gate: an accepted booking is manageable only while it's in the
  // future (can't reschedule/cancel a meeting that already happened). An
  // unreadable instant is not "in the future": with no time to compare, the
  // page says so rather than offering actions it cannot reason about.
  const isPast = startUtc !== null && new Date(startUtc).getTime() <= now.getTime();
  const canManage = booking.status === 'accepted' && startUtc !== null && !isPast;

  const hour12 = !locale.toLowerCase().startsWith('es');
  const summary = (
    <BookingSummary
      m={messages}
      eyebrow={m.title}
      title={booking.title}
      dayLine={startUtc ? formatDayLong(startUtc, tz, locale) : null}
      timeLine={startUtc && endUtc ? formatTimeRange(startUtc, endUtc, tz, locale, hour12) : null}
      timeZoneLabel={readableZone(tz)}
      unreadableTime={m.timeUnreadable}
      withLine={`${m.withLabel} ${booking.host?.name ?? attendee.name} · ${attendee.email}`}
      // Rendered from the SNAPSHOTTED kind; a booking written before the kind
      // existed has none and falls back to its raw location text.
      locationLabel={formatBookingLocation(booking.locationKind, booking.location, messages)}
      locationKind={booking.locationKind ?? null}
      joinUrl={meetingUrl}
      statusLine={booking.status !== 'accepted' ? t(m.bookingIs, { status: statusText(booking.status) }) : null}
    />
  );
  const durationMinutes =
    startUtc && endUtc ? Math.max(1, Math.round((Date.parse(endUtc) - Date.parse(startUtc)) / 60_000)) : 30;

  return (
    <BrandedShell brandColor={branding.brandColor} style={branding.style} className="bp-viewport">
      <main className="w-full py-10 md:px-6 md:py-12">
        {canManage ? (
          <ManageActions
            uid={uid}
            token={token}
            slots={avail?.slots ?? []}
            timeZone={tz}
            locale={locale}
            messages={messages}
            summary={summary}
            durationMinutes={durationMinutes}
            nowUtc={range.from}
          />
        ) : (
          <BookingStage m={messages} step="done">
            <section className="bp-card bp-notice">
              {summary}
              <p className="bp-muted">{isPast && booking.status === 'accepted' ? m.alreadyTookPlace : m.cannotChange}</p>
            </section>
          </BookingStage>
        )}
      </main>
      <MadeWithBadge locale={locale} accountCode={booking.reschedule?.accountCode} />
    </BrandedShell>
  );
}
