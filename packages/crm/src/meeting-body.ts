/**
 * The meeting body a host reads inside their CRM.
 *
 * #63 splits this ticket from #64 exactly here: H1a renders the intake answers
 * as TEXT in the body; #64 maps them to structured CRM properties. Keeping the
 * text render pure and separate is what lets #64 be purely about mapping.
 *
 * Value formatting is implemented locally rather than importing `answerText`
 * from `@slate/notifications`: a dependency between two sibling adapter
 * packages costs more than the dozen lines it would save, and this renderer's
 * output goes to a CRM record rather than an email, so the two are free to
 * diverge later without either dragging the other.
 */

import { BOOKING_UTM_KEYS, type BookingUtm } from '@slate/types';

/** The few fixed labels this body needs, supplied by the caller from the i18n catalog. */
export interface MeetingBodyLabels {
  host: string;
  bookingReference: string;
  yes: string;
  no: string;
}

export interface MeetingBodyInput {
  hostName: string | null;
  bookingUid: string;
  answers: { label: string; value: unknown }[];
  /** The campaign the booking came from (`booking.utm`); absent or null when none. */
  utm?: BookingUtm | null;
  labels: MeetingBodyLabels;
}

/**
 * `label: answer` lines, plus the assigned host, the booking's campaign and the
 * booking reference.
 *
 * The campaign is one `utm_*: value` line per key the booking kept, in the
 * order a UTM link lists them, under the key itself: it is the name the host
 * put on the link and the one a marketer searches for, so it is never
 * translated. A booking without UTMs adds no line.
 *
 * The host line is here because `hubspot_owner_id` is deliberately left unset
 * (#63): setting it needs an owner lookup by email plus another scope, and the
 * pilot's checklist is two checkboxes. So the assigned host is stated as text.
 *
 * The booking reference is the `uid` and NOT the manage link. The manage link
 * carries a token that CANCELS and RESCHEDULES the invitee's booking — a
 * capability whose intended audience is the invitee's mailbox, not every seat
 * in a shared CRM and everything the record is ever exported to. The uid is
 * traceable without being a key.
 */
export function renderMeetingBody(input: MeetingBodyInput): string {
  const lines: string[] = [];
  if (input.hostName) lines.push(`${input.labels.host}: ${input.hostName}`);
  for (const a of input.answers) {
    const text = answerText(a.value, input.labels);
    if (text) lines.push(`${a.label}: ${text}`);
  }
  for (const key of BOOKING_UTM_KEYS) {
    const value = input.utm?.[key]?.trim();
    if (value) lines.push(`${key}: ${value}`);
  }
  lines.push(`${input.labels.bookingReference}: ${input.bookingUid}`);
  return withoutMarkup(lines.join('\n'));
}

/**
 * The body as text a CRM cannot read as markup: answers and campaign values
 * come from whoever opened the booking link, and a CRM that renders the body
 * as rich text would otherwise turn `<a href=...>` in one into a live link on
 * the host's record. Only `<` and `>` change, so an `&` in "R&D" reads as typed.
 */
function withoutMarkup(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `[Canceled] ` prefix on cancel, applied once — a re-run must not stack it. */
export function prefixCancelledTitle(title: string, prefix: string): string {
  return title.startsWith(prefix) ? title : `${prefix}${title}`;
}

/**
 * One answer as text. Objects are DROPPED rather than JSON-dumped: a raw
 * `{"a":1}` in a CRM record is noise a salesperson has to decode, and no
 * intake field type produces one today.
 */
function answerText(value: unknown, labels: MeetingBodyLabels): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? labels.yes : labels.no;
  if (Array.isArray(value)) {
    return value
      .map((v) => answerText(v, labels))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') return '';
  return String(value).trim();
}
