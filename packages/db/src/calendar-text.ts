/**
 * The calendar event's own title and description, rendered from the event
 * type's templates onto one booking (`renderCalendarText` in @slate/engine).
 *
 * Runs when a booking is placed and again when it moves, on every path that
 * does either (personal, team, the v1 move and the v2 move's new booking), so
 * the title and the body never carry a stale time or depend on which surface
 * made the booking. The result is stored: `booking.title` (which the calendar
 * write, both .ics files, the emails' `{{event_title}}`, the confirmation, the
 * manage page and the CRM already read) and `booking.calendar_description`.
 *
 * Reads the booking the way its emails do (`loadBookingNotificationContext`),
 * so the invitee, the answers and the Where are the same ones the mail names.
 *
 * A move renders the texts whose templates exist at that moment. Without a
 * title template the booking keeps the title it has: a title is how its
 * guests know the meeting, and renaming it because a template was removed
 * would surprise them. A description this booking had and no longer renders
 * (its template was removed, or now prints nothing) is emptied, so the next
 * calendar move clears it rather than leave a stale time in the event.
 *
 * A SHARED slot (the event type has seats, or someone took one) is the
 * exception: its stored text may have been rendered for its first booker
 * before the seats existed, so without a template it goes back to the event's
 * name and no description. It also runs when someone takes a seat, so the
 * person joining never reads another invitee's data.
 */
import { sql } from 'drizzle-orm';
import { plainCalendarTitle, renderCalendarText, type CalendarText } from '@slate/engine';
import { formatBookingLocation, getMessages } from '@slate/shared';
import type { Db } from './client';
import { loadBookingNotificationContext } from './parity';

/**
 * Render the event type's calendar templates for the booking `uid` and store
 * them. Returns what was written (a text left alone is absent from it; an
 * emptied description is `''`), or null when nothing was: no template and
 * nothing to empty, no booking, a move that landed meanwhile, or a failure.
 *
 * Never throws: a template must never fail a booking or a move, which have
 * already committed by the time this runs. A failure is logged and leaves the
 * booking as it was written (the event's name, no description).
 */
export async function applyCalendarTemplates(db: Db, uid: string): Promise<CalendarText | null> {
  try {
    const row = await db.get<{
      id: string;
      start_ms: number;
      end_ms: number;
      stored_description: string | null;
      seated: number | null;
      event_name: string;
      title_template: string | null;
      description_template: string | null;
      seats: number | null;
    }>(
      sql`SELECT b.id, b.start_ms, b.end_ms, b.calendar_description AS stored_description, b.seated,
                 et.title AS event_name, et.calendar_title_template AS title_template,
                 et.calendar_description_template AS description_template,
                 et.seats_per_time_slot AS seats
          FROM booking b JOIN event_type et ON et.id = b.event_type_id
          WHERE b.uid = ${uid} LIMIT 1`,
    );
    if (!row) return null;
    const hadDescription = !!row.stored_description?.trim();
    // Shared by every seat-taker: while the event type has seats, and for good
    // once someone took one, whatever the seats are now.
    const seated = Number(row.seats ?? 1) > 1 || Number(row.seated) === 1;
    let rendered: CalendarText = {};
    if (row.title_template?.trim() || row.description_template?.trim()) {
      const ctx = await loadBookingNotificationContext(db, uid);
      if (!ctx) return null;
      const locale = ctx.hostLocale === 'es' ? 'es' : 'en';
      rendered = renderCalendarText(
        { title: row.title_template, description: row.description_template },
        {
          locale,
          seated,
          uid: ctx.uid,
          eventName: ctx.eventName ?? ctx.title,
          bookingTitle: ctx.title,
          eventDescription: ctx.eventDescription,
          startUtc: ctx.startUtc,
          endUtc: ctx.endUtc,
          location: formatBookingLocation(ctx.locationKind, ctx.location, getMessages(locale)),
          workspaceName: ctx.workspaceName,
          teamName: ctx.teamName,
          host: ctx.host,
          attendee: ctx.attendee,
          answers: ctx.formAnswers,
          questions: ctx.bookingFields.map((f) => f.name),
        },
      );
    }
    const written: CalendarText = {};
    if (rendered.title !== undefined) written.title = rendered.title;
    else if (seated) written.title = plainCalendarTitle(row.event_name);
    if (rendered.description) written.description = rendered.description;
    else if (hadDescription) written.description = '';
    const sets: ReturnType<typeof sql>[] = [];
    if (written.title !== undefined) sets.push(sql`title = ${written.title}`);
    if (written.description !== undefined) sets.push(sql`calendar_description = ${written.description}`);
    if (sets.length === 0) return null;
    const assign = sets.reduce((a, c) => sql`${a}, ${c}`);
    // Only onto the time it was rendered for: when a second move landed in
    // between, that move's own render writes the text for where it now is.
    const updated = await db.get<{ id: string }>(
      sql`UPDATE booking SET ${assign}
          WHERE id = ${row.id} AND start_ms = ${row.start_ms} AND end_ms = ${row.end_ms}
          RETURNING id`,
    );
    return updated ? written : null;
  } catch (err) {
    console.warn(
      `calendar text: booking ${uid} keeps its title and description as written: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * The safe text for a shared slot whose render did not land: the event's name
 * and no description, since what is stored may be the first booker's own.
 * Written only onto the time the caller saw (`startMs`, `endMs`), like a
 * render: a move that landed meanwhile has rendered its own text, already
 * shared (the event type has seats, or this would not be a seat), and its
 * calendar move carries every guest. Returns what was written, or null when
 * nothing was (the booking moved, or this failed); then the caller must not
 * rewrite the event for the new seat-taker.
 */
export async function applySharedFallback(
  db: Db,
  booking: { id: string; startMs: number; endMs: number },
  eventName: string,
): Promise<CalendarText | null> {
  try {
    const title = plainCalendarTitle(eventName);
    const updated = await db.get<{ id: string }>(
      sql`UPDATE booking SET title = ${title},
            calendar_description = CASE WHEN calendar_description IS NULL THEN NULL ELSE '' END
          WHERE id = ${booking.id} AND start_ms = ${booking.startMs} AND end_ms = ${booking.endMs}
          RETURNING id`,
    );
    return updated ? { title } : null;
  } catch (err) {
    console.warn(
      `calendar text: booking ${booking.id} could not be reset to its shared text: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
