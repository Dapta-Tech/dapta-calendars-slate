/**
 * The seam between the booking data layer and the `CrmProvider` PORT
 * (`@slate/crm`), mirroring what `calendar-refs.ts` does for calendars.
 *
 * It owns everything the port needs from the DB and NOTHING it does not: the
 * invitee's identity, the meeting's times and title, the assigned host, and the
 * intake answers already paired with their human labels. The port never sees a
 * `Db`, and this module never sees an HTTP client.
 *
 * Unlike the calendar seam, this one MAY name its vendor further down the
 * stack — ADR 0001 carves CRM out of R15 — but there is nothing vendor-shaped
 * here either: an adapter for a second CRM would consume this identical
 * context.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { parseJsonColumn, type BookingFieldDef } from './repository';

/** One intake answer, paired with the label the host actually wrote. */
export interface CrmAnswer {
  label: string;
  value: unknown;
}

/** Everything the port needs to write one booking out to a CRM. */
export interface CrmWriteContext {
  bookingId: string;
  uid: string;
  accountId: string;
  title: string;
  startUtc: string;
  endUtc: string;
  status: string;
  invitee: {
    email: string;
    /** Split from the single `name` the booking form collects; see `splitName`. */
    firstName: string | null;
    lastName: string | null;
  };
  hostName: string | null;
  /** The host reads this record, so the body is rendered in THEIR locale. */
  hostLocale: string | null;
  answers: CrmAnswer[];
  /**
   * The booking this one replaced, when the reschedule contract minted a NEW
   * uid rather than moving the existing row.
   *
   * Load-bearing for the CRM: #63 promises ONE meeting per booking, PATCHed on
   * reschedule and never duplicated. Under the new-uid contract the meeting was
   * created against the PREDECESSOR's booking id, so without this the successor
   * looks like a booking that was never written out — and the CRM would end up
   * holding a stale meeting at the old time plus a second one at the new.
   */
  rescheduledFromUid: string | null;
}

/**
 * Split a display name into first/last for the CRM's two name properties.
 *
 * The booking form collects ONE name field, and HubSpot wants `firstname` and
 * `lastname`. First token to the first, the remainder to the last — wrong for
 * some name orders, and deliberately not smarter than that: this value is only
 * ever written when creating a contact the CRM does NOT already have, and a
 * contact it already knows keeps its own name untouched (#63). Guessing harder
 * would buy nothing and could produce a worse split.
 */
export function splitName(full: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const trimmed = (full ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: null, lastName: null };
  const i = trimmed.indexOf(' ');
  if (i === -1) return { firstName: trimmed, lastName: null };
  return { firstName: trimmed.slice(0, i), lastName: trimmed.slice(i + 1) };
}

/**
 * Load the booking + invitee + host + labelled intake answers for a CRM write.
 * Returns null when the booking is gone — a deleted booking is a no-op, not an
 * error to retry.
 *
 * The answers are labelled HERE rather than in the adapter because the labels
 * live on the event type (`booking_fields`) while the answers live on the
 * booking (`responses`), and joining two tables is this layer's job. An answer
 * whose field the host has since deleted falls back to its raw key: a body that
 * says `budget: 50k` is worth more than one that silently drops the answer.
 */
export async function loadBookingForCrmWrite(db: Db, uid: string): Promise<CrmWriteContext | null> {
  const b = await db.get<{
    id: string;
    uid: string;
    account_id: string;
    title: string;
    start_ms: number;
    end_ms: number;
    status: string;
    responses: unknown;
    rescheduled_from_uid: string | null;
    booking_fields: unknown;
    host_name: string | null;
    host_locale: string | null;
  }>(
    sql`SELECT b.id, b.uid, b.account_id, b.title, b.start_ms, b.end_ms, b.status, b.responses,
               b.rescheduled_from_uid,
               et.booking_fields, m.display_name AS host_name, m.locale AS host_locale
        FROM booking b
        LEFT JOIN event_type et ON et.id = b.event_type_id
        LEFT JOIN member m ON m.id = b.host_member_id
        WHERE b.uid = ${uid} LIMIT 1`,
  );
  if (!b) return null;

  // The INVITEE only. `booking_guest` rows are deliberately not contacts (#63):
  // N extra calls per booking, and the guest is not the lead.
  const attendee = await db.get<{ name: string; email: string }>(
    sql`SELECT name, email FROM booking_attendee WHERE booking_id = ${b.id}
        ORDER BY id LIMIT 1`,
  );
  if (!attendee?.email) return null;

  const fields = parseJsonColumn<BookingFieldDef[]>(b.booking_fields, []);
  const labels = new Map(fields.map((f) => [f.name, f.label]));
  const responses = parseJsonColumn<Record<string, unknown>>(b.responses, {});
  const answers: CrmAnswer[] = Object.entries(responses).map(([name, value]) => ({
    label: labels.get(name) ?? name,
    value,
  }));

  return {
    bookingId: b.id,
    uid: b.uid,
    accountId: b.account_id,
    title: b.title,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
    status: b.status,
    invitee: { email: attendee.email, ...splitName(attendee.name) },
    hostName: b.host_name,
    hostLocale: b.host_locale,
    answers,
    rescheduledFromUid: b.rescheduled_from_uid,
  };
}
