import { Inject, Injectable } from '@nestjs/common';
import type { CalendarProvider } from '@slate/calendar';
import {
  claimBookingDestination,
  deleteBookingReferences,
  fillBookingReference,
  loadBookingForCalendarWrite,
  loadBookingReferences,
  releaseBookingReference,
  type Db,
} from '@slate/db';
import { CALENDAR, DB } from './tokens';

/**
 * The single place the booking lifecycle reaches the CalendarProvider PORT to
 * WRITE events out (and the availability path reaches it to READ busy times via
 * `provider`). Every method is FIRE-AND-FORGET and fully behind the port:
 *
 *   - Contract B8: a calendar (vendor) failure NEVER rolls back the booking —
 *     effects run after the booking result is committed, all `void …catch`.
 *   - OSS clone-and-run: the default provider is disabled (`enabled === false`),
 *     so every method short-circuits and nothing is written. A private overlay
 *     swaps in a real provider — no call site changes.
 *
 * No vendor is named here (R15); only the generic port + `booking_reference`.
 */
@Injectable()
export class CalendarEffects {
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
   * pending→accepted confirm): create the remote event on each destination
   * calendar and persist a `booking_reference` per created event.
   */
  onBookingAccepted(uid: string): void {
    if (!this.calendar.enabled) return;
    void this.writeEvent(uid).catch(() => undefined);
  }

  /** A booking was cancelled/declined: delete its remote event(s). */
  onBookingCancelled(uid: string): void {
    if (!this.calendar.enabled) return;
    void this.removeEvent(uid).catch(() => undefined);
  }

  /**
   * A booking moved (reschedule): delete the old remote event and re-create it
   * at the new time. Kept as delete+create so it works for any provider whose
   * "update" is not idempotent; the booking_reference is rewritten.
   */
  onBookingRescheduled(uid: string): void {
    if (!this.calendar.enabled) return;
    void (async () => {
      await this.removeEvent(uid);
      await this.writeEvent(uid);
    })().catch(() => undefined);
  }

  private async writeEvent(uid: string): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx || ctx.destinationRefs.length === 0) return;
    for (const connectionRef of ctx.destinationRefs) {
      // DH1: claim (booking_id, destination) FIRST. A retry / concurrent confirm
      // loses the claim → skips createEvent → no duplicate external event.
      const claimId = await claimBookingDestination(this.db, ctx.bookingId, connectionRef);
      if (!claimId) continue;
      let created;
      try {
        created = await this.calendar.createEvent({
          connectionRef,
          title: ctx.title,
          startUtc: ctx.startUtc,
          endUtc: ctx.endUtc,
          attendeeEmails: ctx.attendeeEmails,
          organizerEmail: ctx.organizerEmail,
          // B9: the exact literal that triggers a conferencing link.
          requestConferenceLink: ctx.location === 'google_meet',
          timeZone: ctx.attendeeTimeZone,
        });
      } catch (err) {
        // createEvent failed → drop the claim so a later retry can re-create.
        await releaseBookingReference(this.db, claimId);
        throw err;
      }
      await fillBookingReference(this.db, claimId, {
        externalEventId: created.externalEventId,
        // Store the connection ref so a later delete addresses the same calendar.
        externalCalendarId: created.externalCalendarId ?? connectionRef,
        meetingUrl: created.meetingUrl ?? null,
      });
    }
  }

  private async removeEvent(uid: string): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const refs = await loadBookingReferences(this.db, ctx.bookingId);
    for (const ref of refs) {
      if (!ref.externalEventId) continue;
      await this.calendar.deleteEvent({
        connectionRef: ref.externalCalendarId ?? ctx.destinationRefs[0] ?? '',
        externalEventId: ref.externalEventId,
      });
    }
    await deleteBookingReferences(this.db, ctx.bookingId);
  }
}
