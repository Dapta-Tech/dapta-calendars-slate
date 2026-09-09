import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CalendarProvider } from '@slate/calendar';
import { getMessages } from '@slate/shared';
import {
  claimBookingDestination,
  deleteBookingReferences,
  enqueueOutbox,
  fillBookingReference,
  loadBookingForCalendarWrite,
  loadBookingReferences,
  releaseBookingReference,
  setBookingReferenceMeetingUrl,
  type Db,
} from '@slate/db';
import { CALENDAR, DB } from './tokens';

/** Calendar lifecycle transitions the outbox can carry. */
export type CalendarAction = 'create' | 'delete' | 'reschedule';

/**
 * The single place the booking lifecycle reaches the CalendarProvider PORT to
 * WRITE events out (and the availability path reaches it to READ busy times via
 * `provider`). Fully behind the port; no vendor is named here (R15) — only the
 * generic port + `booking_reference`.
 *
 * DURABILITY (B7 / audit DM1): the lifecycle no longer fire-and-forgets the
 * write. Each transition ENQUEUES an `outbox` row; the OutboxWorker drains it
 * with retry+backoff and calls `runCalendarJob` below. So:
 *   - Contract B8: a calendar failure NEVER rolls back the booking — the
 *     lifecycle only enqueues (a fast local INSERT) and returns; the actual
 *     vendor call happens out-of-band in the worker.
 *   - No silent loss: a provider outage retries instead of vanishing.
 *   - Idempotent: the DH1 claim (`booking_reference` unique index) means a retry
 *     cannot double-create a remote event.
 *   - OSS clone-and-run: the default provider is disabled (`enabled === false`),
 *     so nothing is ever enqueued and behavior is unchanged.
 */
@Injectable()
export class CalendarEffects {
  private readonly log = new Logger('CalendarEffects');

  constructor(
    @Inject(CALENDAR) private readonly calendar: CalendarProvider,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** The wired provider — handed to the availability path for busy-subtraction. */
  get provider(): CalendarProvider {
    return this.calendar;
  }

  /**
   * A booking became `accepted` (fresh accept, host on-behalf, team, or a
   * pending→accepted confirm): queue a durable create of the remote event.
   */
  onBookingAccepted(uid: string): void {
    this.enqueue('create', uid);
  }

  /** A booking was cancelled/declined: queue a durable delete of its event(s). */
  onBookingCancelled(uid: string): void {
    this.enqueue('delete', uid);
  }

  /** A booking moved (reschedule): queue a durable MOVE of the existing event. */
  onBookingRescheduled(uid: string): void {
    this.enqueue('reschedule', uid);
  }

  /**
   * Record the transition on the outbox. No-op when no calendar is wired (the
   * OSS default) so a bare clone enqueues nothing. The enqueue itself is a fast
   * local INSERT; we keep the call site synchronous (never blocks the booking
   * response) and only log if the enqueue itself fails.
   */
  private enqueue(action: CalendarAction, uid: string): void {
    if (!this.calendar.enabled) return;
    void enqueueOutbox(this.db, {
      kind: 'calendar',
      action,
      bookingUid: uid,
    }).catch((err) => {
      this.log.error(`failed to enqueue calendar ${action} for ${uid}: ${String(err)}`);
    });
  }

  /**
   * The worker's executor for a claimed calendar outbox row. Performs the real
   * vendor write via the port and THROWS on failure so the worker retries
   * (idempotent via the DH1 claim). No-op when the provider is disabled.
   */
  async runCalendarJob(action: CalendarAction, uid: string): Promise<void> {
    if (!this.calendar.enabled) return;
    if (action === 'delete') {
      await this.removeEvent(uid);
    } else if (action === 'reschedule') {
      await this.moveEvent(uid);
    } else {
      await this.writeEvent(uid);
    }
  }

  /**
   * A true reschedule: MOVE the existing remote event(s) to the booking's new
   * time via `updateEvent`, keeping the same `externalEventId` so attendees see
   * the event move (no cancel + fresh invite, no duplicate). Slate's reschedule
   * keeps the same booking uid, so the stored `booking_reference` rows are the
   * events to move. If nothing was written yet (e.g. accepted then rescheduled
   * before the create drained), fall back to a fresh create.
   */
  private async moveEvent(uid: string): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const refs = await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event');
    const movable = refs.filter((r) => r.externalEventId);
    if (movable.length === 0) {
      await this.writeEvent(uid);
      return;
    }
    // Organizer's destination first, mirroring write-out: only that event may
    // (re)mint a room, so a move can never split a team booking into two rooms.
    const organizerRef = ctx.destinationRefs[0];
    const ordered = [...movable].sort((a, b) =>
      Number(b.destination === organizerRef) - Number(a.destination === organizerRef),
    );
    const wantsLink = ctx.locationKind === 'conferencing';
    // Already have a room? Then never ask for another. This is what keeps a
    // RETRIED move (the outbox re-runs the whole job after a partial failure)
    // from churning a fresh room on every attempt against a backend that
    // reissues rather than echoes.
    const storedUrl = refs.find((r) => r.meetingUrl)?.meetingUrl ?? null;
    let meetingUrl: string | null = null;
    for (const ref of ordered) {
      // Identity, not position: if NO movable ref belongs to the organizer, none
      // is the organizer, and nobody re-mints — rather than promoting an
      // arbitrary co-host and minting a second room behind the invitee's back.
      const isOrganizer = ref.destination === organizerRef;
      const updated = await this.calendar.updateEvent({
        connectionRef: ref.destination ?? ctx.destinationRefs[0] ?? '',
        calendarId:
          ref.externalCalendarId ??
          ctx.destinationCalendarIds[ref.destination ?? ctx.destinationRefs[0] ?? ''],
        externalEventId: ref.externalEventId!,
        title: ctx.title,
        startUtc: ctx.startUtc,
        endUtc: ctx.endUtc,
        attendeeEmails: ctx.attendeeEmails,
        organizerEmail: ctx.organizerEmail,
        requestConferenceLink: wantsLink && isOrganizer && !storedUrl,
        timeZone: ctx.attendeeTimeZone,
      });
      if (isOrganizer) meetingUrl = updated.meetingUrl ?? null;
    }
    // Persist ONLY a non-null URL, and ONLY after every move landed — one
    // booking-wide UPDATE rather than per-ref inside the loop. A throw partway
    // through would otherwise leave some rows on the new room and some on the
    // old, and the email, the manage page and /v1 could each read a different
    // one. A backend that keeps the same room and simply does not echo it must
    // never blank a good stored link.
    if (meetingUrl) await setBookingReferenceMeetingUrl(this.db, ctx.bookingId, meetingUrl);
  }

  /**
   * C2: ONE conferencing room per booking, not one per host.
   *
   * `destinationRefs` is ordered organizer-first (its documented contract), and
   * only `[0]` requests a link. A collective booking used to set
   * `requestConferenceLink` on every destination, minting a room per host for a
   * single meeting and leaving which one the invitee got to a `LIMIT 1`. The
   * co-hosts' events are created in a second pass carrying the organizer's URL
   * as description text — the port already has `description`, so #60's
   * `CreateEventInput` contract is untouched.
   *
   * Sequential and fail-fast: if the organizer's create throws, the whole job
   * throws and the outbox retries it, with the DH1 claim keeping destinations
   * that already succeeded from being written twice.
   */
  private async writeEvent(uid: string): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx || ctx.destinationRefs.length === 0) return;
    const wantsLink = ctx.locationKind === 'conferencing';
    // The room, once the organizer's destination has minted it. Every later
    // destination is told about it instead of asking for one of its own.
    let meetingUrl: string | null = null;
    for (const [index, connectionRef] of ctx.destinationRefs.entries()) {
      const isOrganizer = index === 0;
      // DH1: claim (booking_id, destination) FIRST. A retry / concurrent confirm
      // loses the claim → skips createEvent → no duplicate external event.
      const claimId = await claimBookingDestination(this.db, ctx.bookingId, connectionRef);
      if (!claimId) {
        // Already written by an earlier partial run. If that was the organizer's
        // destination, adopt the room it minted rather than minting a second one.
        if (isOrganizer && wantsLink) {
          const existing = await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event');
          meetingUrl =
            existing.find((r) => r.destination === connectionRef)?.meetingUrl ??
            existing.find((r) => r.meetingUrl)?.meetingUrl ??
            null;
        }
        continue;
      }
      let created;
      try {
        created = await this.calendar.createEvent({
          connectionRef,
          calendarId: ctx.destinationCalendarIds[connectionRef],
          title: ctx.title,
          startUtc: ctx.startUtc,
          endUtc: ctx.endUtc,
          attendeeEmails: ctx.attendeeEmails,
          organizerEmail: ctx.organizerEmail,
          // Co-hosts get the organizer's room as text; only the organizer's
          // destination is allowed to mint one.
          // Labelled in the organizer's locale — a bare URL alone in an event
          // body says nothing about what it is, and every other surface this
          // feature touches is EN+ES.
          description: meetingUrl
            ? `${getMessages(ctx.organizerLocale === 'es' ? 'es' : 'en').manage.joinMeeting}: ${meetingUrl}`
            : null,
          // B9: the booking's snapshotted location KIND triggers the link — no
          // vendor literal on the public path (R15, ADR 0008).
          requestConferenceLink: wantsLink && isOrganizer,
          timeZone: ctx.attendeeTimeZone,
        });
      } catch (err) {
        // createEvent failed → drop the claim so a later retry can re-create.
        await releaseBookingReference(this.db, claimId);
        throw err;
      }
      if (isOrganizer && wantsLink) meetingUrl = created.meetingUrl ?? null;
      await fillBookingReference(this.db, claimId, {
        externalEventId: created.externalEventId,
        // Preserve the exact provider-calendar target for a later reschedule.
        // Some backends only return the event id, so fall back to the selected
        // calendar beneath the connection rather than to the connection itself.
        externalCalendarId:
          created.externalCalendarId ?? ctx.destinationCalendarIds[connectionRef] ?? null,
        // The organizer's room on EVERY row — never a competing URL a co-host's
        // backend volunteered unasked. That is what makes the readers' `LIMIT 1`
        // deterministic without an ORDER BY.
        meetingUrl: isOrganizer ? (created.meetingUrl ?? null) : meetingUrl,
      });
    }
  }

  private async removeEvent(uid: string): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const refs = await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event');
    for (const ref of refs) {
      if (!ref.externalEventId) continue;
      await this.calendar.deleteEvent({
        connectionRef: ref.destination ?? ctx.destinationRefs[0] ?? '',
        externalEventId: ref.externalEventId,
      });
    }
    // Only the calendar's rows: the CRM's reference points at a meeting that
    // is PATCHed to cancelled, not deleted, and is still needed to do that.
    await deleteBookingReferences(this.db, ctx.bookingId, 'calendar_event');
  }
}
