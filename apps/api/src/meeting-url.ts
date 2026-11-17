import { sql } from '@slate/db';
import { wantsConferencingLink } from './email-effects';

/**
 * Where a booking's video link stands, for an answer given before it exists.
 * The link is minted by the calendar write the outbox runs a few seconds after
 * the booking (ADR 0007), so a booking answered at once can carry none yet.
 *  - ready: the link is there.
 *  - pending: the calendar write is still on its way; read the booking again shortly.
 *  - on_confirmation: a request waiting for the host; the link is made once it is confirmed.
 *  - none: no link is coming (not a video meeting, no calendar to make one, or the write gave up).
 */
export const MEETING_URL_STATUSES = ['ready', 'pending', 'on_confirmation', 'none'] as const;
export type MeetingUrlStatus = (typeof MEETING_URL_STATUSES)[number];

/**
 * The link of booking `b`, as every reader takes it: from its calendar events,
 * or, for a date of a repeating host event, the series' one room (ADR 0012).
 */
export const bookingMeetingUrlSql = sql`COALESCE(
  (SELECT br.meeting_url FROM booking_reference br
   WHERE br.booking_id = b.id AND br.meeting_url IS NOT NULL LIMIT 1),
  (SELECT s.meeting_url FROM host_event_series s
   WHERE s.id = b.recurring_event_id AND b.event_type_id IS NULL))`;

/** 1 while a calendar write for booking `b` is queued or running (`hasPendingCalendarJob`), else 0. */
export const calendarWritingSql = sql`CASE WHEN EXISTS (
  SELECT 1 FROM outbox o
  WHERE o.kind = 'calendar' AND o.booking_uid = b.uid AND o.status = 'pending' AND o.action <> 'reinvite'
) THEN 1 ELSE 0 END`;

export function meetingUrlStatus(b: {
  status: string;
  locationKind: string | null;
  location: string | null;
  meetingUrl: string | null;
  calendarWriting: boolean;
}): MeetingUrlStatus {
  if (b.meetingUrl) return 'ready';
  if (!wantsConferencingLink(b.locationKind, b.location)) return 'none';
  if (b.status === 'pending') return 'on_confirmation';
  return b.status === 'accepted' && b.calendarWriting ? 'pending' : 'none';
}
