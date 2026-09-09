import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatBookingLocation, formatSlotDateTime, getMessages, t } from '@slate/shared';
import { getManageView, getAvailability, getTeamAvailability } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { ManageActions } from './manage-actions';
import { MadeWithBadge } from '@/components/made-with-badge';

// Token-gated personal page: never indexed, and the title stays generic so no
// booking detail leaks into link previews or crawlers.
export const metadata: Metadata = {
  title: 'Manage your booking',
  robots: { index: false, follow: false },
};

/**
 * The manage link no longer opens a booking. Rendered instead of throwing, and
 * instead of a bare 404, because the commonest way to get here is benign: the
 * manage token rotates on every reschedule, so the link in an EARLIER email is
 * supposed to stop working. The booking is fine; only the link is stale.
 */
async function ManageLinkInvalid() {
  const locale = await publicLocale();
  const m = getMessages(locale).manage;
  return (
    <>
      <main className="mx-auto max-w-xl px-6 py-12">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">{m.linkInvalidTitle}</h1>
        <p className="rounded-md border border-border bg-card p-4 text-muted-foreground">
          {m.linkInvalidBody}
        </p>
      </main>
      <MadeWithBadge locale={locale} />
    </>
  );
}

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

  const result = await getManageView(uid, token);
  // A booking that does not exist is a 404. A link that no longer opens one is
  // NOT — the manage token rotates on every reschedule, so an older emailed
  // link is expected to stop working, and saying so beats both a bare 404 and
  // the thrown error boundary this used to produce (#123).
  if (!result.ok) {
    if (result.reason === 'not-found') notFound();
    return <ManageLinkInvalid />;
  }
  const booking = result.booking;

  // The body is PARSED, not asserted — and a body that fails to parse is handed
  // over as it arrived rather than discarded, because it still describes a real
  // booking (#123). So render from what is actually there: `startUtc` is read
  // through `Date.parse` first, and an unreadable instant costs the time line
  // instead of throwing `RangeError` out of `formatSlotDateTime` and into the
  // public error boundary — which is precisely what #102 looked like on the
  // confirmation, on a page reached from a confirmation EMAIL.
  const startUtc = Number.isNaN(Date.parse(booking.startUtc ?? '')) ? null : booking.startUtc;
  const attendee = booking.attendee ?? { name: '', email: '', timeZone: 'UTC' };
  const tz = attendee.timeZone || 'UTC';
  // Public emailed link — no admin cookie; take the locale from the browser.
  const locale = await publicLocale();
  const messages = getMessages(locale);
  const m = messages.manage;
  const statusText = (s: string) =>
    s === 'pending' ? m.statusPending : s === 'cancelled' ? m.statusCancelled : s === 'rejected' ? m.statusRejected : s;
  // Only render a meeting link if it's an http(s) URL — `meeting_url` is a
  // free-text column; never render a javascript:/data: value as an href.
  const meetingUrl = booking.meetingUrl && /^https?:\/\//i.test(booking.meetingUrl) ? booking.meetingUrl : null;

  // Engine-backed reschedule options (G7): only real, bookable slots — asked of
  // the route that can SEE this event type. A team event type has `team_id` and
  // no `member_id`, so the personal route's `account + member + slug` lookup
  // misses it entirely: it answered nothing, the picker rendered its empty
  // state, and a team invitee could cancel but never reschedule (#122). The
  // context says which kind it is rather than leaving the page to infer it.
  const now = new Date();
  // Named `range`, not `window`: this module is a server component today, but a
  // binding that shadows the global `window` is a trap for whoever next adds a
  // client-side branch here.
  const range = {
    from: now.toISOString(),
    to: new Date(now.getTime() + 21 * 86_400_000).toISOString(),
  };
  const rs = booking.status === 'accepted' ? booking.reschedule : undefined;
  const avail = !rs
    ? null
    : rs.kind === 'team'
      ? await getTeamAvailability({
          accountCode: rs.accountCode,
          teamSlug: rs.teamSlug,
          slug: rs.slug,
          ...range,
        })
      : await getAvailability({
          accountCode: rs.accountCode,
          handle: rs.handle,
          slug: rs.slug,
          ...range,
        });

  // Granular gate: an accepted booking is manageable only while it's in the
  // future (can't reschedule/cancel a meeting that already happened). An
  // unreadable instant is not "in the future" — with no time to compare, the
  // page says so rather than offering actions it cannot reason about.
  const isPast = startUtc !== null && new Date(startUtc).getTime() <= now.getTime();
  const canManage = booking.status === 'accepted' && startUtc !== null && !isPast;

  return (
    <>
      <main className="mx-auto max-w-xl px-6 py-12">
        <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{booking.title}</h1>
        <p className="text-muted-foreground">
          {startUtc ? formatSlotDateTime(startUtc, tz) : m.timeUnreadable}
        </p>
        <p className="text-sm text-muted-foreground">
          {m.withLabel} {booking.host?.name ?? attendee.name} · {attendee.email}
        </p>
        {/* Rendered from the SNAPSHOTTED kind; a booking written before the
            kind existed has none and falls back to its raw location text. */}
        {formatBookingLocation(booking.locationKind, booking.location, messages) ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{messages.location.whereLabel}:</span>{' '}
            {formatBookingLocation(booking.locationKind, booking.location, messages)}
          </p>
        ) : null}
        {meetingUrl ? (
          <p className="text-sm">
            <a href={meetingUrl} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer">
              {m.joinMeeting} →<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
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
      <MadeWithBadge locale={locale} accountCode={booking.reschedule?.accountCode} />
    </>
  );
}
