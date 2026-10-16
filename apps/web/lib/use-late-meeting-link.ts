import { useEffect, useState } from 'react';
import type { BookingView } from '@slate/types';
import { manageTokenOf } from './manage-token';

/**
 * F5: the join link of an online meeting that was booked a moment ago.
 *
 * The confirmation screen builds its "Add to calendar" file from the create
 * response, and the room does not exist yet then: the calendar write-out mints
 * it afterwards, from the outbox (ADR 0007). The emails wait for it and the
 * manage page reads it fresh; this screen asks the booking again, a few times
 * and further apart each time, until the link is there, so the file the
 * visitor takes carries it. Bounded: when the write-out is slow or failed, the
 * file keeps its human location, which is what it carried before.
 *
 * Only for a CONFIRMED online meeting with no link yet. A request waiting on
 * the host has no room until the host accepts it, and every other kind of
 * place has no link to wait for.
 */
export const LATE_LINK_DELAYS_MS = [1_500, 2_500, 4_000, 6_000, 8_000, 10_000, 12_000] as const;


/**
 * What the hook reads of a booking. `locationKind` is a plain string: the
 * create response names none, so the page passes the kind it shows.
 */
export type LateLinkBooking = Pick<BookingView, 'uid' | 'status' | 'meetingUrl' | 'manageUrl'> & {
  locationKind?: string | null;
};

/** Whether this booking's join link is still to come (and worth asking for). */
export function awaitsMeetingLink(
  booking: Omit<LateLinkBooking, 'uid'> | null | undefined,
): boolean {
  return (
    !!booking &&
    booking.status === 'accepted' &&
    booking.locationKind === 'conferencing' &&
    !booking.meetingUrl &&
    !!manageTokenOf(booking.manageUrl)
  );
}

/**
 * The link once it exists, else null. `fetchLink` asks the booking for it with
 * the visitor's own manage credential (a server action, so the API base is read
 * at run time) and answers null while there is none.
 */
export function useLateMeetingLink(
  booking: LateLinkBooking | null | undefined,
  fetchLink: (uid: string, token: string) => Promise<string | null>,
  delays: readonly number[] = LATE_LINK_DELAYS_MS,
): string | null {
  const [link, setLink] = useState<{ uid: string; url: string } | null>(null);
  const waiting = awaitsMeetingLink(booking);
  const uid = booking?.uid ?? null;
  const token = manageTokenOf(booking?.manageUrl);

  useEffect(() => {
    if (!waiting || !uid || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number) => {
      if (attempt >= delays.length) return;
      timer = setTimeout(async () => {
        let url: string | null = null;
        try {
          url = await fetchLink(uid, token);
        } catch {
          url = null; // a failed read is one more "not yet"
        }
        if (cancelled) return;
        if (url) setLink({ uid, url });
        else ask(attempt + 1);
      }, delays[attempt]);
    };
    ask(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `fetchLink` and `delays` are fixed for a page; the booking is the key.
  }, [waiting, uid, token]);

  // Never another booking's link: a second booking on the same page starts over.
  return link && link.uid === uid ? link.url : null;
}
