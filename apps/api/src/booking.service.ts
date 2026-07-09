import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  cancelBooking,
  createBooking,
  createTeamBooking,
  dispatchWebhooks,
  getAccountByCode,
  getAvailability,
  getPublicProfile,
  getTeamAvailability,
  getTeamProfile,
  rescheduleBooking,
  reserveSlot,
  resolveBooking,
  parseJsonColumn,
  sql,
} from '@slate/db';
import { verifyManageToken } from '@slate/engine';
import { BookingNotifier } from '@slate/notifications';
import type { ServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import {
  availabilityQuerySchema,
  availabilityResponseSchema,
  createBookingSchema,
  reserveSlotSchema,
  type AvailabilityResponse,
  type BookingView,
  type PublicProfile,
  type TeamProfile,
} from '@slate/types';
import { DB, ENV, NOTIFIER } from './tokens';

export type ServiceError = { error: string; message: string; status: number };

@Injectable()
export class BookingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NOTIFIER) private readonly notifier: BookingNotifier,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
  ) {}

  private manageUrl(uid: string, token: string): string {
    return `${this.env.PUBLIC_APP_URL}/manage/${uid}?token=${token}`;
  }

  async profile(accountCode: string, handle: string): Promise<PublicProfile | null> {
    const p = await getPublicProfile(this.db, accountCode, handle);
    return (p as PublicProfile | undefined) ?? null;
  }

  async availability(raw: unknown): Promise<AvailabilityResponse | null> {
    const q = availabilityQuerySchema.parse(raw);
    const fromMs = new Date(q.from).getTime();
    // Cap the search window at 60 days (contract §Engine) — clamp `to` rather
    // than reject, so an over-wide agent query still returns a bounded result.
    const toMs = Math.min(new Date(q.to).getTime(), fromMs + 60 * 86_400_000);
    const result = await getAvailability(
      this.db,
      {
        accountCode: q.accountCode,
        handle: q.handle,
        slug: q.slug,
        fromMs,
        toMs,
        displayTimeZone: q.timeZone,
      },
      // Subtract the host's real connected-calendar busy times (no-op on the
      // OSS default disabled provider).
      this.calendar.provider,
    );
    if (!result) return null;
    return availabilityResponseSchema.parse({
      eventType: result.eventType,
      timeZone: result.timeZone,
      // result.slots are already {startUtc, spotsLeft?, capacity?} (group-aware).
      slots: result.slots,
    });
  }

  /** Reserve a 10-minute soft hold on a slot (public reserve→confirm two-step). */
  async reserve(raw: unknown): Promise<{ reservationUid: string; expiresAt: string } | ServiceError> {
    const input = reserveSlotSchema.parse(raw);
    const held = await reserveSlot(this.db, {
      accountCode: input.accountCode,
      handle: input.handle,
      slug: input.slug,
      startMs: new Date(input.startUtc).getTime(),
    });
    if (!held.ok) {
      if (held.reason === 'NOT_FOUND')
        return { error: 'NOT_FOUND', message: 'No such booking page.', status: 404 };
      if (held.reason === 'RATE_LIMITED')
        return { error: 'RATE_LIMITED', message: 'Too many active holds. Try again shortly.', status: 429 };
      return { error: 'INVALID_SLOT', message: 'That time is not available to hold.', status: 400 };
    }
    return { reservationUid: held.uid, expiresAt: new Date(held.releaseAtMs).toISOString() };
  }

  async book(raw: unknown, onBehalf = false): Promise<BookingView | ServiceError> {
    const input = createBookingSchema.parse(raw);
    const outcome = await createBooking(this.db, {
      accountCode: input.accountCode,
      handle: input.handle,
      slug: input.slug,
      startMs: new Date(input.startUtc).getTime(),
      attendee: input.attendee,
      answers: input.answers,
      reservationUid: input.reservationUid,
      idempotencyKey: input.idempotencyKey,
      onBehalf,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'NOT_FOUND')
        return { error: 'NOT_FOUND', message: 'No such booking page.', status: 404 };
      if (outcome.reason === 'INVALID')
        return { error: 'INTAKE_INVALID', message: outcome.message, status: 400 };
      if (outcome.reason === 'RESERVATION_EXPIRED')
        return { error: 'RESERVATION_EXPIRED', message: 'Your hold on this time expired. Please pick a time again.', status: 410 };
      return { error: 'SLOT_TAKEN', message: 'That time was just booked. Pick another slot.', status: 409 };
    }

    const b = outcome.booking;
    const startUtc = new Date(b.startMs).toISOString();
    const endUtc = new Date(b.endMs).toISOString();
    // Idempotent replay returns an empty token → do NOT reissue a manage link
    // (single-active-token invariant); only mint a URL for a fresh booking.
    const manageUrl = outcome.manageToken ? this.manageUrl(b.uid, outcome.manageToken) : undefined;

    if (outcome.manageToken) {
      // Write the event to the host's real calendar — only once the booking is
      // ACCEPTED. A pending (requiresConfirmation) booking writes out on confirm,
      // not now. No-op when no calendar is connected. (B8: never blocks/rolls back.)
      if (b.status === 'accepted') this.calendar.onBookingAccepted(b.uid);
      void this.notifier
        .sendConfirmation({
          uid: b.uid,
          title: b.title,
          startUtc,
          endUtc,
          host: { name: b.hostName },
          attendee: b.attendee,
          manageUrl,
        })
        .catch(() => undefined);
      void getAccountByCode(this.db, input.accountCode)
        .then((acc) =>
          acc
            ? dispatchWebhooks(this.db, acc.id, 'booking.created', {
                uid: b.uid,
                status: b.status,
                startUtc,
                endUtc,
                title: b.title,
              })
            : undefined,
        )
        .catch(() => undefined);
    }

    return {
      uid: b.uid,
      status: b.status as BookingView['status'],
      title: b.title,
      startUtc,
      endUtc,
      host: { name: b.hostName, handle: b.hostHandle },
      attendee: b.attendee,
      manageUrl,
    };
  }

  // --- Manage (token-gated public reschedule/cancel) ----------------------

  async manageView(uid: string, token: string): Promise<BookingView | ServiceError> {
    const b = await resolveBooking(this.db, uid);
    if (!b) return { error: 'NOT_FOUND', message: 'Booking not found.', status: 404 };
    // Reuse the repository verify by attempting a no-op check via cancel/reschedule guards
    const meta = parseJsonColumn<{ _manage?: { tokenHash?: string } }>(b.metadata, {});
    if (!verifyManageToken(token, meta._manage?.tokenHash ?? null))
      return { error: 'FORBIDDEN', message: 'Invalid manage link.', status: 403 };
    const attendee = await this.db.get<{ name: string; email: string; time_zone: string | null }>(
      sql`SELECT name, email, time_zone FROM booking_attendee WHERE booking_id = ${b.id} LIMIT 1`,
    );
    return {
      uid: b.uid,
      status: b.status as BookingView['status'],
      title: b.title,
      startUtc: new Date(Number(b.start_ms)).toISOString(),
      endUtc: new Date(Number(b.end_ms)).toISOString(),
      host: { name: null, handle: null },
      attendee: {
        name: attendee?.name ?? '',
        email: attendee?.email ?? '',
        timeZone: attendee?.time_zone ?? 'UTC',
      },
    };
  }

  async cancel(
    uid: string,
    opts: { reason?: string; token?: string; byHost?: boolean },
  ): Promise<{ uid: string; status: string } | ServiceError> {
    const out = await cancelBooking(this.db, {
      uid,
      reason: opts.reason,
      manageToken: opts.token,
      byHost: opts.byHost,
    });
    if (!out.ok) return this.mapMutation(out.reason);
    // Delete the remote calendar event (no-op when none was written).
    this.calendar.onBookingCancelled(uid);
    // Best-effort cancellation email with a CANCEL .ics.
    const att = await this.loadAttendee(uid);
    if (att) {
      void this.notifier
        .sendCancellation({
          uid,
          title: att.title,
          startUtc: out.startUtc,
          endUtc: out.endUtc,
          host: { name: att.hostName },
          attendee: att.attendee,
          cancellationReason: opts.reason ?? null,
        })
        .catch(() => undefined);
    }
    this.fireWebhook(uid, 'booking.cancelled', { uid, reason: opts.reason ?? null });
    return { uid: out.uid, status: 'cancelled' };
  }

  async reschedule(
    uid: string,
    opts: { newStartUtc: string; token?: string; byHost?: boolean },
  ): Promise<{ uid: string; startUtc: string; endUtc: string } | ServiceError> {
    const out = await rescheduleBooking(this.db, {
      uid,
      newStartMs: new Date(opts.newStartUtc).getTime(),
      manageToken: opts.token,
      byHost: opts.byHost,
    });
    if (!out.ok) return this.mapMutation(out.reason);
    // Move the remote calendar event to the new time (delete + re-create).
    this.calendar.onBookingRescheduled(uid);
    const att = await this.loadAttendee(uid);
    if (att && out.manageToken) {
      void this.notifier
        .sendReschedule({
          uid,
          title: att.title,
          startUtc: out.startUtc,
          endUtc: out.endUtc,
          host: { name: att.hostName },
          attendee: att.attendee,
          manageUrl: this.manageUrl(uid, out.manageToken),
        })
        .catch(() => undefined);
    }
    this.fireWebhook(uid, 'booking.rescheduled', { uid, startUtc: out.startUtc, endUtc: out.endUtc });
    return { uid: out.uid, startUtc: out.startUtc, endUtc: out.endUtc };
  }

  /** Best-effort webhook dispatch for a booking lifecycle event. */
  private fireWebhook(uid: string, event: string, data: Record<string, unknown>): void {
    void resolveBooking(this.db, uid)
      .then((bk) => (bk ? dispatchWebhooks(this.db, bk.account_id, event, data) : undefined))
      .catch(() => undefined);
  }

  private mapMutation(reason: 'NOT_FOUND' | 'FORBIDDEN' | 'SLOT_TAKEN' | 'GONE'): ServiceError {
    switch (reason) {
      case 'NOT_FOUND':
        return { error: 'NOT_FOUND', message: 'Booking not found.', status: 404 };
      case 'FORBIDDEN':
        return { error: 'FORBIDDEN', message: 'Invalid manage link.', status: 403 };
      case 'GONE':
        return { error: 'GONE', message: 'Booking is no longer active.', status: 410 };
      case 'SLOT_TAKEN':
        return { error: 'SLOT_TAKEN', message: 'That time is taken.', status: 409 };
    }
  }

  private async loadAttendee(uid: string) {
    const row = await this.db.get<{
      title: string;
      name: string;
      email: string;
      time_zone: string | null;
      host_name: string | null;
    }>(
      sql`SELECT b.title, a.name, a.email, a.time_zone, m.display_name AS host_name
          FROM booking b
          LEFT JOIN booking_attendee a ON a.booking_id = b.id
          LEFT JOIN member m ON m.id = b.host_member_id
          WHERE b.uid = ${uid} LIMIT 1`,
    );
    if (!row) return null;
    return {
      title: row.title,
      hostName: row.host_name,
      attendee: { name: row.name, email: row.email, timeZone: row.time_zone ?? 'UTC' },
    };
  }

  // --- Teams --------------------------------------------------------------

  async teamProfile(accountCode: string, teamSlug: string): Promise<TeamProfile | null> {
    return (await getTeamProfile(this.db, accountCode, teamSlug)) as TeamProfile | null;
  }

  async teamAvailability(
    accountCode: string,
    teamSlug: string,
    slug: string,
    from: string,
    to: string,
    timeZone?: string,
  ): Promise<AvailabilityResponse | null> {
    const result = await getTeamAvailability(
      this.db,
      {
        accountCode,
        teamSlug,
        slug,
        fromMs: new Date(from).getTime(),
        toMs: new Date(to).getTime(),
        displayTimeZone: timeZone,
      },
      this.calendar.provider,
    );
    if (!result) return null;
    return availabilityResponseSchema.parse({
      eventType: result.eventType,
      timeZone: result.timeZone,
      slots: result.slots.map((startUtc) => ({ startUtc })),
    });
  }

  async teamBook(
    accountCode: string,
    teamSlug: string,
    body: { slug: string; startUtc: string; attendee: BookingView['attendee']; answers?: Record<string, unknown> },
  ): Promise<{ uid: string; hostMemberId: string } | ServiceError> {
    const out = await createTeamBooking(this.db, {
      accountCode,
      teamSlug,
      slug: body.slug,
      startMs: new Date(body.startUtc).getTime(),
      attendee: body.attendee,
      answers: body.answers,
    });
    if (!out.ok) {
      if (out.reason === 'NOT_FOUND') return { error: 'NOT_FOUND', message: 'Not found.', status: 404 };
      if (out.reason === 'INVALID')
        return { error: 'INTAKE_INVALID', message: out.message ?? 'Invalid.', status: 400 };
      return { error: 'SLOT_TAKEN', message: 'That time is taken.', status: 409 };
    }
    // A team booking is created `accepted` → write it to the chosen host's calendar.
    this.calendar.onBookingAccepted(out.uid);
    return { uid: out.uid, hostMemberId: out.hostMemberId };
  }
}
