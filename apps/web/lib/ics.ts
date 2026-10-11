/**
 * The confirmation's "Add to calendar" file: one VEVENT, `METHOD:PUBLISH`.
 *
 * A file the visitor opens themselves, not an invitation: no ORGANIZER, no
 * ATTENDEE, no RSVP. The booking email already carries the iTIP REQUEST; this
 * uses the same UID (the booking's uid), so a calendar that already holds that
 * invite treats the file as the same event rather than a second one.
 *
 * Kept here rather than imported from `@slate/notifications`, which builds the
 * emailed invite and pulls a mail transport in with it; this one runs in the
 * browser and needs twenty lines, not a mail stack.
 */

/** `2026-03-02T14:30:00.000Z` as `20260302T143000Z` (RFC 5545 §3.3.5, UTC form). */
function icsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold to 75 octets per line (§3.1); continuation lines start with a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

export interface CalendarFileInput {
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  /** Where, in words ("Online meeting", an address). */
  location?: string | null;
  /**
   * The join link. Like the emailed invite, it becomes both `LOCATION` (a bare
   * link is what calendars linkify) and `URL`; and `URL` is a URI, not TEXT,
   * so it is written verbatim: TEXT-escaping it would backslash the `,` and
   * `;` in a real query string and break the link. Only http(s) is accepted.
   */
  url?: string | null;
  /** The instant the file is made; injected so the output is testable. */
  stamp: string;
}

export function buildCalendarFile(input: CalendarFileInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slate//Calendars//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${icsUtc(input.stamp)}`,
    `DTSTART:${icsUtc(input.startUtc)}`,
    `DTEND:${icsUtc(input.endUtc)}`,
    `SUMMARY:${icsText(input.title)}`,
  ];
  const url = input.url && /^https?:\/\/[^\s]+$/i.test(input.url) ? input.url : null;
  const location = url ?? input.location;
  if (location) lines.push(`LOCATION:${icsText(location)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A `data:` href for the file, so the link works with no request and no blob URL to revoke. */
export function calendarFileHref(input: CalendarFileInput): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildCalendarFile(input))}`;
}

/** A filename a person recognises in their downloads: the event, not a uid. */
export function calendarFileName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${base || 'booking'}.ics`;
}
