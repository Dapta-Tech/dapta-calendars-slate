import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CalendarProvider } from '@slate/calendar';
import type { ServerEnv } from '@slate/config/env';
import { getMessages } from '@slate/shared';
import {
  claimBookingDestination,
  DEFAULT_MAX_ATTEMPTS,
  deleteBookingReferences,
  enqueueOutbox,
  fillBookingReference,
  findCalendarChangeForInviteeEmail,
  loadBookingForCalendarWrite,
  loadBookingHostConnectionRefs,
  attendeesFor,
  loadBookingReferences,
  normalizeAttendeeEmail,
  readCalendarChangeMark,
  releaseBookingReference,
  setBookingReferenceMeetingUrl,
  skipQueuedOutboxRow,
  sql,
  writeCalendarChangeMark,
  type CalendarChangeMark,
  type CalendarWriteContext,
  type Db,
} from '@slate/db';
import { BUSY_CACHE_DEFAULTS, BusyCache, CachedBusyProvider } from './busy-cache';
import type { EmailProvider } from '@slate/notifications';
import { OutboxSkipError, wantsConferencingLink } from './email-effects';
import { CALENDAR, DB, EMAIL, ENV } from './tokens';

/**
 * Calendar lifecycle transitions the outbox can carry. `reinvite` is not one:
 * it has the provider invite the guest after all, when a change was written
 * without the provider's invitation and the invitee email it counted on never
 * went out (`EmailEffects.afterGaveUp`).
 */
export type CalendarAction = 'create' | 'delete' | 'reschedule' | 'reinvite';

/** The outbox row a calendar job runs for: its id, how many times it has already failed, and its mark. */
export interface CalendarJobRow {
  id: string;
  attempts: number;
  /** What the row recorded about the invitee email it goes with, as claimed. */
  mark?: CalendarChangeMark | null;
}

/**
 * The body of one written event: the booking's rendered description (from the
 * event type's template; none without one, and none when it was emptied),
 * then, on a co-host's copy, the organizer's room as a labelled line. Labelled
 * in the organizer's locale: a bare URL alone in an event body says nothing
 * about what it is. Null when there is neither, which is how an event without
 * a template always read.
 */
export function eventBody(
  ctx: Pick<CalendarWriteContext, 'description' | 'organizerLocale'>,
  joinUrl: string | null,
): string | null {
  const join = joinUrl
    ? `${getMessages(ctx.organizerLocale === 'es' ? 'es' : 'en').manage.joinMeeting}: ${joinUrl}`
    : null;
  return [ctx.description, join].filter(Boolean).join('\n\n') || null;
}

/**
 * How long a calendar change waits before its first attempt, so the invitee's
 * email that the same request queues has marked it by then
 * (`tagCalendarChangeWithInviteeEmail`). Far below the conferencing grace on
 * that email (`CONFERENCING_LINK_GRACE_MS`), so the join link is still minted
 * first.
 */
export const INVITEE_EMAIL_GRACE_MS = 3_000;

/**
 * How many times a calendar DELETE looks at the invitee's cancellation email
 * before deciding who tells the guest. A deleted event cannot be cancelled
 * again later, so unlike a create or a move (see `reinvite`) the delete must
 * know first. The looks are counted on the row's own mark (`emailWaits`),
 * apart from the write's failures, and have their own room in its attempt
 * budget (the delete row is queued with `DEFAULT_MAX_ATTEMPTS +
 * INVITEE_EMAIL_MAX_LOOKS`). Once they are spent, the email is taken back if
 * it has not started going out, and the provider sends its own cancellation,
 * as it did before; one already being sent is waited for, up to
 * `INVITEE_EMAIL_MAX_LOOKS` looks in all.
 */
export const INVITEE_EMAIL_WAIT_ATTEMPTS = 3;

/**
 * The most looks a delete takes in all, the ones at an email being sent right
 * now included. Past it the provider cancels whatever the email does: a
 * delete must never be left undone.
 */
export const INVITEE_EMAIL_MAX_LOOKS = 2 * INVITEE_EMAIL_WAIT_ATTEMPTS;

/** The least wait between two looks at the cancellation email. */
export const INVITEE_EMAIL_RETRY_MS = 3_000;

/**
 * Thrown by a calendar job that must first see another row settle: a delete
 * while the invitee's cancellation email is still queued and the bounded wait
 * has room, or a `reinvite` whose change has not run yet. Retryable: the
 * worker backs it off and looks again, and `last_error` names the wait.
 */
export class InviteeEmailPendingError extends Error {
  readonly retryAfterMs = INVITEE_EMAIL_RETRY_MS;
}

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
  /** The display cache of busy reads (ADR 0009); null when off or with no calendar. */
  private readonly busyCache: BusyCache | null;
  private readonly display: CalendarProvider;

  constructor(
    @Inject(CALENDAR) private readonly calendar: CalendarProvider,
    @Inject(DB) private readonly db: Db,
    // Optional and LAST so the specs that build this positionally keep working.
    // Without an env there is no cache, and `displayProvider` is the raw one.
    @Optional() @Inject(ENV) env?: ServerEnv,
    // The mail transport, read only for whether it delivers at all
    // (`providerInvites`). Absent: assumed to.
    @Optional() @Inject(EMAIL) private readonly email?: Pick<EmailProvider, 'delivers'>,
  ) {
    const ttlMs = env?.CALENDAR_BUSY_CACHE_TTL_MS ?? 0;
    this.busyCache =
      env && calendar.enabled && ttlMs > 0
        ? new BusyCache({
            ttlMs,
            maxStaleMs: env.CALENDAR_BUSY_CACHE_MAX_STALE_MS ?? BUSY_CACHE_DEFAULTS.maxStaleMs,
            maxEntries: env.CALENDAR_BUSY_CACHE_MAX_ENTRIES ?? BUSY_CACHE_DEFAULTS.maxEntries,
            readTimeoutMs: env.CALENDAR_BUSY_READ_TIMEOUT_MS ?? BUSY_CACHE_DEFAULTS.readTimeoutMs,
            failureCooldownMs: BUSY_CACHE_DEFAULTS.failureCooldownMs,
            warn: (line) => this.log.warn(line),
          })
        : null;
    this.display = this.busyCache ? new CachedBusyProvider(calendar, this.busyCache) : calendar;
  }

  /**
   * The wired provider, read FRESH on every call. Everything that DECIDES
   * something reads busy through this one: a hold, a booking, a reschedule, a
   * host's confirmation, the connection self-test. Never cached (ADR 0009).
   */
  get provider(): CalendarProvider {
    return this.calendar;
  }

  /**
   * The provider for reads that only SHOW availability: the booking and team
   * pages, the manage page's reschedule picker, the host's new-booking screen,
   * the slot reads of the machine and v2 surfaces. Busy comes from a short
   * per-connection cache, with the last good read standing in (for a bounded
   * time) when the calendar fails or is slow. Never hand it to a write path:
   * a time it shows is re-checked fresh through `provider` before anything is
   * held or booked.
   */
  get displayProvider(): CalendarProvider {
    return this.display;
  }

  /**
   * A booking became `accepted` (fresh accept, host on-behalf, team, or a
   * pending→accepted confirm): queue a durable create of the remote event.
   */
  onBookingAccepted(uid: string): void {
    this.forgetBusy(uid);
    this.enqueue('create', uid);
  }

  /** A booking was cancelled/declined: queue a durable delete of its event(s). */
  onBookingCancelled(uid: string): void {
    this.forgetBusy(uid);
    this.enqueue('delete', uid);
  }

  /** A booking moved (reschedule): queue a durable MOVE of the existing event. */
  onBookingRescheduled(uid: string): void {
    this.forgetBusy(uid);
    this.enqueue('reschedule', uid);
  }

  /**
   * A booking changed in a way that writes nothing to a calendar (a request
   * made or declined): only this process's cached busy reads for its hosts are
   * cleared. Other replicas catch up within the cache's TTL.
   */
  onBookingChanged(uid: string): void {
    this.forgetBusy(uid);
  }

  /**
   * Clear this process's cached busy reads for the calendars of a booking's
   * hosts. Never throws and never blocks the caller: the cache only feeds what
   * a page shows, and a stale display costs at most one TTL.
   */
  private forgetBusy(uid: string): void {
    const cache = this.busyCache;
    if (!cache) return;
    void loadBookingHostConnectionRefs(this.db, uid)
      .then((refs) => cache.invalidate(refs))
      .catch((err) => this.log.warn(`could not clear cached busy reads: ${err instanceof Error ? err.name : 'error'}`));
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
      // A short head start for the invitee's email, which the same request
      // queues right after and which marks this row (`providerInvites`). Well
      // inside the grace a conferencing email waits for this write's link, so
      // the link still comes first.
      nextAttemptAt: Date.now() + INVITEE_EMAIL_GRACE_MS,
      // A delete may wait for its cancellation email; the wait has its own budget.
      ...(action === 'delete' ? { maxAttempts: DEFAULT_MAX_ATTEMPTS + INVITEE_EMAIL_MAX_LOOKS } : {}),
    }).catch((err) => {
      this.log.error(`failed to enqueue calendar ${action} for ${uid}: ${String(err)}`);
    });
  }

  /**
   * The worker's executor for a claimed calendar outbox row. Performs the real
   * vendor write via the port and THROWS on failure so the worker retries
   * (idempotent via the DH1 claim). No-op when the provider is disabled.
   */
  async runCalendarJob(
    action: CalendarAction,
    uid: string,
    payload: string | null = null,
    job?: CalendarJobRow,
  ): Promise<void> {
    if (!this.calendar.enabled) return;
    // The invitee email queued for this very change, when there is one.
    const mark = readCalendarChangeMark(payload);
    const inviteeEmailId = mark?.inviteeEmailId;
    if (job) job = { ...job, mark };
    if (action !== 'delete') {
      // A write or a move is for a booking that is ON. One that was cancelled
      // or declined while this row waited (a retry can wait hours) must not
      // put an event back on the host's calendar: nothing would ever delete
      // it. Skipped, not retried; the delete queued behind it runs next.
      const row = await this.db.get<{ status: string }>(
        sql`SELECT status FROM booking WHERE uid = ${uid} LIMIT 1`,
      );
      if (row && row.status !== 'accepted') {
        throw new OutboxSkipError(`calendar ${action} for ${uid} skipped: the booking is ${row.status}`);
      }
    }
    if (action === 'reinvite') {
      await this.reinviteGuest(uid, inviteeEmailId);
    } else if (action === 'delete') {
      await this.removeEvent(uid, inviteeEmailId, job);
    } else if (action === 'reschedule') {
      await this.moveEvent(uid, inviteeEmailId, job);
    } else {
      await this.writeEvent(uid, inviteeEmailId, job);
    }
    // The hosts' calendars now hold (or no longer hold) the event, so a read
    // cached before this write is out of date on this process.
    this.forgetBusy(uid);
  }

  /**
   * A true reschedule: MOVE the existing remote event(s) to the booking's new
   * time via `updateEvent`, keeping the same `externalEventId` so attendees see
   * the event move (no cancel + fresh invite, no duplicate). Slate's reschedule
   * keeps the same booking uid, so the stored `booking_reference` rows are the
   * events to move. If nothing was written yet (e.g. accepted then rescheduled
   * before the create drained), fall back to a fresh create.
   */
  private async moveEvent(uid: string, inviteeEmailId?: string, job?: CalendarJobRow): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const refs = await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event');
    const movable = refs.filter((r) => r.externalEventId);
    if (movable.length === 0) {
      // The same change, so the same email: the tag rides along.
      await this.writeEvent(uid, inviteeEmailId, job);
      return;
    }
    // Organizer's destination first, mirroring write-out: only that event may
    // (re)mint a room, so a move can never split a team booking into two rooms.
    const organizerRef = ctx.destinationRefs[0];
    const ordered = [...movable].sort((a, b) =>
      Number(b.destination === organizerRef) - Number(a.destination === organizerRef),
    );
    const wantsLink = wantsConferencingLink(ctx.locationKind, ctx.location);
    // Already have a room? Then never ask for another. This is what keeps a
    // RETRIED move (the outbox re-runs the whole job after a partial failure)
    // from churning a fresh room on every attempt against a backend that
    // reissues rather than echoes.
    const storedUrl = refs.find((r) => r.meetingUrl)?.meetingUrl ?? null;
    const sendInvitations = await this.providerInvites(ctx, inviteeEmailId, { job });
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
        // Only a booking whose body came from a template sends one (absent
        // leaves the event's body as it is); an emptied one is sent empty, to
        // clear it. A co-host's copy keeps its join line, with the room the
        // organizer's event has now.
        ...(ctx.description !== null
          ? { description: eventBody(ctx, isOrganizer ? null : (meetingUrl ?? storedUrl)) ?? '' }
          : {}),
        startUtc: ctx.startUtc,
        endUtc: ctx.endUtc,
        attendeeEmails: attendeesFor(ctx, ref.destination ?? ctx.destinationRefs[0]),
        organizerEmail: ctx.organizerEmail,
        requestConferenceLink: wantsLink && isOrganizer && !storedUrl,
        timeZone: ctx.attendeeTimeZone,
        sendInvitations,
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
  private async writeEvent(uid: string, inviteeEmailId?: string, job?: CalendarJobRow): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx || ctx.destinationRefs.length === 0) return;
    const wantsLink = wantsConferencingLink(ctx.locationKind, ctx.location);
    const sendInvitations = await this.providerInvites(ctx, inviteeEmailId, { job });
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
          attendeeEmails: attendeesFor(ctx, connectionRef),
          organizerEmail: ctx.organizerEmail,
          // The booking's rendered body (none without a template), and on a
          // co-host's copy the organizer's room as text: only the organizer's
          // destination is allowed to mint one.
          description: eventBody(ctx, meetingUrl),
          // B9: the booking's snapshotted location KIND triggers the link — no
          // vendor literal on the public path (R15, ADR 0008).
          requestConferenceLink: wantsLink && isOrganizer,
          timeZone: ctx.attendeeTimeZone,
          sendInvitations,
        });
      } catch (err) {
        // createEvent failed → drop the claim so a later retry can re-create.
        await releaseBookingReference(this.db, claimId);
        throw err;
      }
      if (isOrganizer && sendInvitations && job?.mark?.providerMuted) {
        // An earlier attempt wrote quietly but never reached this event; this
        // one invited from it, so nothing is left for a reinvite to do.
        await writeCalendarChangeMark(this.db, job.id, { inviteeEmailId: job.mark.inviteeEmailId });
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

  /**
   * F4 (2026-10-30 production E2E): whether the calendar provider should email
   * the attendees itself for this change. The invitee used to get two
   * invitations per booking, and two cancellations: this service's email with
   * its .ics, and the provider's own.
   *
   * The provider stays quiet only on evidence that our email replaces its own:
   * this calendar row carries the id of the invitee email queued for this very
   * change (`tagCalendarChangeWithInviteeEmail`, set by the email side right
   * after it queues that email), that email is still on its way or was
   * accepted by the mail service, and the mail transport actually delivers.
   * Anything else keeps the provider inviting, so the guest is never left with
   * no invitation at all:
   *  - the account switched that email off, or the invitee has no address
   *    (no email is queued, so nothing marks the row);
   *  - the email failed to queue, or was queued after this row already ran;
   *  - the mail service refused it, or the transport gave up on it;
   *  - the transport is log-only or noop (`delivers === false`);
   *  - the booking has guests this service never emails (extra attendees,
   *    guests added later), for whom the provider's invitation is the only one;
   *  - a calendar change no invitee email goes with (guests added, a seat
   *    taken on a shared event).
   *
   * An email still on its way can yet be refused. A create or a move written
   * quietly on one is recorded on its own row (`providerMuted`), and if that
   * email then ends unsent, a `reinvite` job has the provider invite the guest
   * after all (`reinviteGuest`); a retry that invites from the organizer's
   * event clears that record. A deleted event cannot be cancelled again, so a
   * delete (`waitForEmail`) first looks at its email a few times, stays quiet
   * only once the mail service has accepted it, and otherwise takes the email
   * back (unless it is being sent right now) and lets the provider cancel.
   */
  private async providerInvites(
    ctx: CalendarWriteContext,
    inviteeEmailId: string | undefined,
    opts: { job?: CalendarJobRow; waitForEmail?: boolean } = {},
  ): Promise<boolean> {
    if ((ctx.otherGuestCount ?? 0) > 0) return true;
    if (this.email?.delivers === false) return true;
    if (!inviteeEmailId) return true;
    const email = await this.db.get<{ status: string }>(
      sql`SELECT status FROM outbox
          WHERE id = ${inviteeEmailId} AND kind = 'email' AND booking_uid = ${ctx.uid}
          LIMIT 1`,
    );
    // Refused (skipped), given up on (failed) or dropped (gone): it replaces nothing.
    if (email?.status !== 'pending' && email?.status !== 'done') return true;
    if (email.status === 'pending' && opts.waitForEmail) {
      const job = opts.job;
      const waits = job?.mark?.emailWaits ?? 0;
      // Each look is counted on the row's own mark, never in its failures.
      const look = async (why: string): Promise<never> => {
        await writeCalendarChangeMark(this.db, job!.id, { ...job!.mark, inviteeEmailId, emailWaits: waits + 1 });
        throw new InviteeEmailPendingError(why);
      };
      if (job && waits < INVITEE_EMAIL_WAIT_ATTEMPTS) {
        await look(
          `waiting for the invitee's email before deleting the event of ${ctx.uid} (look ${waits + 1}/${INVITEE_EMAIL_WAIT_ATTEMPTS}); the calendar's own cancellation goes out after that`,
        );
      }
      // Still not sent after the wait: take it back, so the guest does not get
      // ours later on top of the provider's, and let the provider tell them.
      const reason = `not sent: the calendar sent its own cancellation for ${ctx.uid}`;
      if (await skipQueuedOutboxRow(this.db, inviteeEmailId, reason)) return true;
      const now = await this.db.get<{ status: string }>(
        sql`SELECT status FROM outbox WHERE id = ${inviteeEmailId} LIMIT 1`,
      );
      if (now?.status === 'pending' && job && waits < INVITEE_EMAIL_MAX_LOOKS) {
        // Being sent right now: its outcome decides, within the looks left.
        await look(`the invitee's email for ${ctx.uid} is being sent; deciding after it`);
      }
      if (now?.status !== 'done') return true;
    }
    if (opts.job) {
      // Recorded before the write: a quiet write that lands and then fails to
      // record would leave nobody to invite the guest if the email is refused.
      await writeCalendarChangeMark(this.db, opts.job.id, { inviteeEmailId, providerMuted: true });
    }
    return false;
  }

  private async removeEvent(uid: string, inviteeEmailId?: string, job?: CalendarJobRow): Promise<void> {
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const refs = await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event');
    const sendInvitations = await this.providerInvites(ctx, inviteeEmailId, { job, waitForEmail: true });
    for (const ref of refs) {
      if (!ref.externalEventId) continue;
      await this.calendar.deleteEvent({
        connectionRef: ref.destination ?? ctx.destinationRefs[0] ?? '',
        externalEventId: ref.externalEventId,
        sendInvitations,
      });
    }
    // Only the calendar's rows: the CRM's reference points at a meeting that
    // is PATCHed to cancelled, not deleted, and is still needed to do that.
    await deleteBookingReferences(this.db, ctx.bookingId, 'calendar_event');
  }

  /**
   * The invitee email a create or a move counted on ended unsent (refused by
   * the mail service, or given up on): have the provider invite the guest
   * after all, so they are not left with no invitation.
   *
   * Queued behind that change in the booking's calendar queue, so the change
   * has run by now. Nothing to do when it wrote with the provider inviting
   * (it saw the email's fate itself), when this already ran, or when the
   * booking is no longer on (the worker skips a reinvite for a cancelled one).
   *
   * Providers invite a guest when the guest is ADDED with notifications on; a
   * save that changes nothing sends nothing (checked against Google on
   * 2026-10-30). So on the organizer's event only: the guest is taken off
   * quietly, then put back with the provider inviting. Same event, same room
   * (no new room is asked for), and the body is left as it is. Only that one
   * event, so the guest gets one invitation, not one per host's copy.
   */
  private async reinviteGuest(uid: string, inviteeEmailId: string | undefined): Promise<void> {
    if (!inviteeEmailId) return;
    const change = await findCalendarChangeForInviteeEmail(this.db, uid, inviteeEmailId);
    if (!change || change.action === 'delete') return;
    if (change.status === 'pending') {
      // Not reachable through the ordered queue unless that change has never
      // run yet; it then reads the email's fate itself. Look again after it.
      throw new InviteeEmailPendingError(`the calendar ${change.action} of ${uid} has not run yet`);
    }
    if (!change.mark.providerMuted || change.mark.reinvited) return;
    const ctx = await loadBookingForCalendarWrite(this.db, uid);
    if (!ctx) return;
    const inviteeKey = ctx.inviteeKey ?? null;
    if (!inviteeKey || inviteeKey === normalizeAttendeeEmail(ctx.organizerEmail)) return;
    const refs = (await loadBookingReferences(this.db, ctx.bookingId, 'calendar_event')).filter((r) => r.externalEventId);
    const target =
      refs.find((r) => r.destination && ctx.organizerDestinationRefs.includes(r.destination)) ??
      refs.find((r) => r.destination === ctx.destinationRefs[0]);
    if (!target) {
      this.log.warn(`no organizer event to invite the guest of ${uid} from`);
      return;
    }
    const destination = target.destination ?? ctx.destinationRefs[0] ?? '';
    const attendees = attendeesFor(ctx, destination);
    const withoutGuest = attendees.filter((e) => normalizeAttendeeEmail(e) !== inviteeKey);
    // A provider keeps the guest list as it is when given none, so the guest
    // can be taken off only while someone else stays on (the organizer, on
    // their own event).
    if (withoutGuest.length === 0 || withoutGuest.length === attendees.length) {
      this.log.warn(`cannot re-invite the guest of ${uid}: the event has nobody else on it`);
      return;
    }
    const event = {
      connectionRef: destination,
      calendarId: target.externalCalendarId ?? ctx.destinationCalendarIds[destination],
      externalEventId: target.externalEventId!,
      title: ctx.title,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
      organizerEmail: ctx.organizerEmail,
      timeZone: ctx.attendeeTimeZone,
    };
    // Two steps, each recorded once done. A retry never takes the guest off
    // again, and putting back a guest who is already on changes nothing, so
    // the provider never invites them twice.
    let mark = change.mark;
    if (!mark.guestRemoved) {
      await this.calendar.updateEvent({ ...event, attendeeEmails: withoutGuest, sendInvitations: false });
      mark = { ...mark, guestRemoved: true };
      await writeCalendarChangeMark(this.db, change.id, mark);
    }
    await this.calendar.updateEvent({ ...event, attendeeEmails: attendees, sendInvitations: true });
    await writeCalendarChangeMark(this.db, change.id, { ...mark, reinvited: true });
    this.log.log(`the provider invited the guest of ${uid}: the invitee email ${inviteeEmailId} was never sent`);
  }
}
