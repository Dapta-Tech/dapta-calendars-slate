/**
 * Minimal RFC 5545 iTIP builder for booking invites. Emits a VCALENDAR with one
 * VEVENT, METHOD REQUEST (confirm/reschedule) or CANCEL, a STABLE UID per
 * booking, and an INCREASING SEQUENCE (confirm=0, reschedule=1, cancel=2) so
 * calendar clients update the same event. CRLF line endings, 75-octet UTF-8
 * line folding, and TEXT escaping per the spec.
 */

export type IcsMethod = 'REQUEST' | 'CANCEL';

export interface IcsInput {
  /** Stable per-booking id (e.g. the booking uid). */
  uid: string;
  method: IcsMethod;
  /** 0 = confirm, 1 = reschedule, 2 = cancel. Must strictly increase per UID. */
  sequence: number;
  startUtc: string;
  endUtc: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /**
   * The conferencing link. When present it becomes BOTH the `URL:` property and
   * the `LOCATION` value — clients linkify a LOCATION reliably only when it is a
   * bare URL, and the join click is the whole point of putting it here. The
   * human label ("Online meeting", or the runtime `conferencingLabel`) is not
   * lost: it is the Where line of the mail this invite is attached to.
   */
  url?: string | null;
  organizer?: { name?: string | null; email?: string | null } | null;
  attendees: Array<{ name?: string | null; email: string }>;
  /** DTSTAMP instant (ISO). Injected for deterministic output/tests. */
  stamp: string;
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * A URI value safe to emit unescaped.
 *
 * `URL:` is a URI, not TEXT, so it must NOT go through `escapeText` — but that
 * makes it the one unescaped sink in this builder, and the value arrives from an
 * external calendar backend. A CR or LF inside it would end the content line and
 * let the rest be read as further iCalendar properties, so line breaks are
 * stripped. Anything that is not an http(s) URL is dropped entirely rather than
 * written into an invite.
 */
function sanitizeUri(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[\r\n]/g, '').trim();
  return /^https?:\/\//i.test(stripped) ? stripped : null;
}

/** Format an ISO instant as a UTC iCalendar date-time (YYYYMMDDTHHMMSSZ). */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Fold a content line to <=75 octets (UTF-8), continuation lines start with a space. */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    // Avoid splitting a multi-byte char: back off until a lead byte boundary.
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines are prefixed with one space
  }
  return out.join('\r\n ');
}

export function buildIcs(input: IcsInput): string {
  const status = input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slate//Calendars//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${toIcsUtc(input.stamp)}`,
    `DTSTART:${toIcsUtc(input.startUtc)}`,
    `DTEND:${toIcsUtc(input.endUtc)}`,
    `SUMMARY:${escapeText(input.title)}`,
    `STATUS:${status}`,
  ];
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  // A link, when there is one, is the most useful thing LOCATION can hold.
  const url = sanitizeUri(input.url);
  const location = url ?? input.location;
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  // RFC 5545 types URL as a URI, NOT as TEXT — so it is emitted verbatim.
  // Running it through escapeText would backslash-escape the `,` and `;` that
  // occur in real query strings and corrupt the link.
  if (url) lines.push(`URL:${url}`);
  if (input.organizer?.email) {
    const cn = input.organizer.name ? `;CN=${escapeText(input.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${input.organizer.email}`);
  }
  for (const a of input.attendees) {
    const cn = a.name ? `;CN=${escapeText(a.name)}` : '';
    lines.push(`ATTENDEE${cn};RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Content type for an iTIP attachment of the given method.
 *
 * MUST NOT include a `charset` parameter: the managed email service's attachment
 * handler 500s on a `text/calendar; …; charset=utf-8` content-type (verified live
 * — `; method=REQUEST` alone → 202 accepted; adding `; charset=utf-8` → 500). That
 * silently killed every .ics-bearing mail (confirmation/cancellation) while the
 * no-attachment mails (pending/reminder) went out fine. `method` is what makes it
 * an iTIP invite and is safe; utf-8 is the default for text/* so dropping the
 * explicit charset changes nothing for clients. */
export function icsContentType(method: IcsMethod): string {
  return `text/calendar; method=${method}`;
}
