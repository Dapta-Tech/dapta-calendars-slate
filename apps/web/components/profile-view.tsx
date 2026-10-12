import Link from 'next/link';
import { t, type BookingMessages } from '@slate/shared';
import { ChevronIcon, HostAvatar } from '@/components/booking-page-parts';

/**
 * A host's (or a team's) public landing: the cover, who they are, and what can
 * be booked with them.
 *
 * Shared by the public profile route, the team landing route and the studio's
 * profile preview, so the three cannot drift (`preview-parity.spec.tsx`). Drawn
 * entirely by the `bp-*` class contract, so the ten style axes reach it the
 * same way they reach the event page.
 *
 * The events are ONE list with a hairline between rows, not a card per event:
 * the information sits on the page, the durations line up as a column of
 * figures, and the `cardStyle` axis frames the list once rather than eight
 * times.
 */
export interface ProfileEvent {
  slug: string;
  title: string;
  description: string | null;
  lengthMinutes: number;
}

export function ProfileView({
  m,
  name,
  context,
  bio,
  avatarUrl,
  coverUrl,
  monogramName,
  events,
  hrefFor,
  emptyText,
}: {
  m: BookingMessages;
  /** The heading: the host's name, or the team's. */
  name: string;
  /** The quiet line above it: the account's name. */
  context?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  /** The name the monogram tile is drawn from, when there is no photo. */
  monogramName?: string;
  events: ProfileEvent[];
  hrefFor: (slug: string) => string;
  /** The sentence shown instead of an empty list. */
  emptyText: string;
}) {
  return (
    <div className="bp-profile">
      {coverUrl ? (
        <img src={coverUrl} alt="" className="bp-cover bp-cover-image" />
      ) : (
        <div aria-hidden className="bp-cover" />
      )}
      <header className="bp-profile-head">
        <div className="bp-profile-avatar">
          <HostAvatar hostName={monogramName ?? name} avatarUrl={avatarUrl} />
        </div>
        {context ? <p className="bp-muted bp-small">{context}</p> : null}
        <h1 className="bp-profile-name">{name}</h1>
        {bio ? <p className="bp-profile-bio">{bio}</p> : null}
      </header>

      {events.length ? (
        <ul className="bp-card bp-event-list">
          {events.map((et) => (
            <li key={et.slug}>
              <Link href={hrefFor(et.slug)} className="bp-event-row">
                <span className="bp-event-row-text">
                  <span className="bp-event-row-title">{et.title}</span>
                  {et.description ? <span className="bp-event-row-description">{et.description}</span> : null}
                </span>
                {/* The duration as a figure: the number set large with tabular
                    digits, so a list of them reads as a column. The whole phrase
                    is what a screen reader hears. */}
                <span className="bp-event-row-length">
                  <span className="sr-only">{t(m.booking.durationMinutes, { minutes: et.lengthMinutes })}</span>
                  <span aria-hidden className="bp-figure">
                    {et.lengthMinutes}
                  </span>
                  <span aria-hidden className="bp-unit">
                    {m.bookingPage.minutesUnit}
                  </span>
                </span>
                <span aria-hidden className="bp-event-row-chevron">
                  <ChevronIcon direction="right" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bp-muted bp-profile-empty">{emptyText}</p>
      )}
    </div>
  );
}
