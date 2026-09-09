import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ServerEnv } from '@slate/config/env';
import {
  CrmAuthError,
  CrmPropertyError,
  prefixCancelledTitle,
  renderMeetingBody,
  type CrmProvider,
} from '@slate/crm';
import { getMessages } from '@slate/shared';
import {
  claimBookingDestination,
  crmDestination,
  enqueueOutbox,
  fillBookingReference,
  loadBookingForCrmWrite,
  loadBookingReferences,
  loadEncryptionKey,
  recordIntegrationHealth,
  releaseBookingReference,
  resolveProviderToken,
  sql,
  type CrmWriteContext,
  type Db,
} from '@slate/db';
import { OutboxSkipError } from './email-effects';
import { CRM, DB, ENV } from './tokens';

/** The CRM lifecycle transitions the outbox can carry. */
export type CrmAction = 'booking_write_out' | 'booking_cancel' | 'booking_reschedule';

const CRM_ACTIONS: ReadonlySet<string> = new Set<CrmAction>([
  'booking_write_out',
  'booking_cancel',
  'booking_reschedule',
]);

/**
 * The single place the booking lifecycle reaches the `CrmProvider` PORT
 * (H1a / #63 / ADR 0001). Structurally a twin of `CalendarEffects`, and
 * deliberately so — the durability argument is identical:
 *
 *   - Nothing is called INLINE from a request handler (invariant 5). Each
 *     transition ENQUEUES a row; the OutboxWorker drains it with retry+backoff.
 *   - A CRM outage can never fail or slow a booking: the lifecycle only does a
 *     fast local INSERT and returns.
 *   - Idempotent via the DH1 claim (`booking_reference`'s unique index), so a
 *     retry PATCHes rather than creating a second meeting.
 *   - Clone-and-run: the default provider is disabled, so nothing is enqueued
 *     and behavior is exactly what it was before this seam existed.
 *
 * ONE ROW, not two: the accept row resolves the contact AND creates the meeting
 * associated to it. Splitting them would need an ordering the outbox does not
 * have, and the meeting cannot be associated before the contact id exists.
 * #74 verified the inline association lands in the same call, which is what
 * makes the single row sufficient rather than merely convenient.
 */
@Injectable()
export class CrmEffects {
  private readonly log = new Logger('CrmEffects');

  constructor(
    @Inject(CRM) private readonly crm: CrmProvider,
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(ENV) private readonly env?: ServerEnv,
  ) {}

  /** The wired provider — handed to the admin service for the connect-time probe. */
  get provider(): CrmProvider {
    return this.crm;
  }

  /**
   * A booking became `accepted`. Only `accepted` ever reaches the CRM: a
   * `pending` booking is not yet a real meeting, because the host has not
   * accepted it (#63).
   */
  onBookingAccepted(uid: string): void {
    this.enqueue('booking_write_out', uid);
  }

  /** Cancelled or declined: PATCH the meeting. A never-written booking is a no-op. */
  onBookingCancelled(uid: string): void {
    this.enqueue('booking_cancel', uid);
  }

  /** Moved: PATCH the times on the SAME meeting — never a second one. */
  onBookingRescheduled(uid: string): void {
    this.enqueue('booking_reschedule', uid);
  }

  /**
   * Record the transition on the outbox. The whole call is `void`-ed off the
   * request path, so the extra SELECT that resolves the account costs the
   * booking nothing.
   *
   * `account_id` is NOT optional bookkeeping: disconnecting an integration
   * marks that account's still-pending rows `skipped`, and it finds them by
   * account. A row enqueued without one is invisible to that sweep and keeps
   * retrying against a portal the user deliberately unplugged.
   */
  private enqueue(action: CrmAction, uid: string): void {
    if (!this.crm.enabled) return;
    void (async () => {
      const booking = await this.db.get<{ account_id: string }>(
        sql`SELECT account_id FROM booking WHERE uid = ${uid} LIMIT 1`,
      );
      if (!booking) throw new Error(`booking ${uid} not found — cannot enqueue a CRM row for it`);
      await enqueueOutbox(this.db, {
        kind: 'crm',
        action,
        bookingUid: uid,
        accountId: booking.account_id,
      });
    })().catch((err) => {
      this.log.error(`failed to enqueue crm ${action} for ${uid}: ${String(err)}`);
    });
  }

  /**
   * The worker's executor for a claimed `crm` row. THROWS on a retryable
   * failure so the worker backs off; throws `OutboxSkipError` for anything a
   * retry could not fix.
   */
  async runCrmJob(action: string, uid: string): Promise<void> {
    if (!this.crm.enabled) return;
    if (!CRM_ACTIONS.has(action)) {
      // A coding fault, not a decision: loud in the delivery log.
      throw new Error(`unknown crm action: ${action}`);
    }
    const ctx = await loadBookingForCrmWrite(this.db, uid);
    // A booking that is gone, or has no invitee email, can never be written
    // out. Recorded once with a reason rather than retried five times.
    if (!ctx) throw new OutboxSkipError('booking is gone or has no invitee email');

    const credential = await this.resolveCredential(ctx.accountId);

    // #63: `accepted` only, checked at DELIVERY rather than trusted from enqueue
    // time. A row can outlive the state it was enqueued for — a booking
    // cancelled while its write-out sat in backoff, or a guest added to a
    // booking the host never accepted — and creating a meeting for a booking
    // that is not on leaves a `SCHEDULED` record nothing will ever cancel.
    //
    // Both CREATING actions are gated, not just the write-out: a reschedule
    // adopts-or-creates too, so gating one door only moves the orphan to the
    // other. `booking_cancel` is deliberately NOT gated — it runs precisely
    // when the booking is no longer accepted, which is the whole point of it.
    if (action !== 'booking_cancel' && ctx.status !== 'accepted') {
      throw new OutboxSkipError(`booking is ${ctx.status}, not accepted — nothing to write out`);
    }

    try {
      if (action === 'booking_write_out') {
        await this.writeOut(ctx, credential);
      } else {
        await this.patchMeeting(ctx, credential, action as CrmAction);
      }
    } catch (err) {
      if (err instanceof CrmAuthError) {
        // 401 or 403. Terminal: the integration goes unhealthy carrying the
        // STRUCTURED provider error (#74's scope list, not prose), and the row
        // stops rather than burning retries on something a retry cannot fix.
        // The integration is NEVER auto-disabled — the credential stays, so
        // fixing the scope in the portal is enough to make it work again.
        if (credential.integrationId) {
          await recordIntegrationHealth(this.db, {
            integrationId: credential.integrationId,
            ok: false,
            detail: err.message,
            errorDetail: {
              category: err.category,
              requiredGranularScopes: err.requiredGranularScopes,
            },
          });
        }
        throw new OutboxSkipError(
          err.requiredGranularScopes.length
            ? `${this.crm.name} rejected the credential (${err.status}); missing scopes: ${err.requiredGranularScopes.join(', ')}`
            : `${this.crm.name} rejected the credential (${err.status})`,
        );
      }
      throw err;
    }

    if (credential.integrationId) {
      await recordIntegrationHealth(this.db, { integrationId: credential.integrationId, ok: true });
    }
  }

  /**
   * A usable token, or a SKIP. No credential is a decision (nobody connected
   * one), not a delivery failure — the `DAPTA_SYNC_URL` precedent.
   */
  private async resolveCredential(
    accountId: string,
  ): Promise<{ token: string; integrationId: string | null }> {
    try {
      const key = this.env?.INTEGRATION_ENCRYPTION_KEY
        ? loadEncryptionKey(this.env.INTEGRATION_ENCRYPTION_KEY)
        : null;
      const resolved = await resolveProviderToken(
        this.db,
        accountId,
        this.crm.name,
        key,
        this.env?.HUBSPOT_PRIVATE_APP_TOKEN,
      );
      if (!resolved) {
        throw new OutboxSkipError(`no ${this.crm.name} credential is connected for this workspace`);
      }
      return resolved;
    } catch (err) {
      if (err instanceof OutboxSkipError) throw err;
      // A stored credential that cannot be opened is a deployment fault — no
      // key, or the wrong one. Backoff cannot outlive it, so it is recorded
      // once with its reason rather than retried five times.
      throw new OutboxSkipError(
        err instanceof Error ? err.message : `could not resolve the ${this.crm.name} credential`,
      );
    }
  }

  /**
   * Resolve the contact, then create its associated meeting, then persist the
   * reference — in that order, because each step needs the previous one's id.
   *
   * DH1: the claim comes FIRST. A retry or a concurrent confirm loses the claim
   * and returns without calling the CRM, so a duplicate meeting is impossible.
   * A throw releases the claim so a later retry can re-create, mirroring
   * `CalendarEffects.writeEvent`.
   */
  private async writeOut(
    ctx: CrmWriteContext,
    credential: { token: string; integrationId: string | null },
  ): Promise<void> {
    const destination = crmDestination(credential.integrationId);
    const claimId = await claimBookingDestination(this.db, ctx.bookingId, destination, 'crm');
    if (!claimId) {
      this.log.debug(`crm write-out for ${ctx.uid} already claimed — nothing to do`);
      return;
    }
    try {
      const contact = await this.crm.resolveContact({
        token: credential.token,
        email: ctx.invitee.email,
        firstName: ctx.invitee.firstName,
        lastName: ctx.invitee.lastName,
      });
      const meeting = await this.createMeetingTolerantOfUnknownProperties(ctx, credential.token, contact.contactId);
      await fillBookingReference(this.db, claimId, {
        externalEventId: meeting.meetingId,
        externalCalendarId: null,
        meetingUrl: null,
      });
    } catch (err) {
      await releaseBookingReference(this.db, claimId);
      throw err;
    }
  }

  /**
   * Cancel and reschedule both PATCH the meeting the write-out created.
   *
   * No reference with an external id means this booking was never written out
   * — cancelling it is a no-op per #63, not an error worth retrying. That is
   * also what makes a `pending` booking's cancellation silent: it never had a
   * meeting to update.
   */
  private async patchMeeting(
    ctx: CrmWriteContext,
    credential: { token: string; integrationId: string | null },
    action: CrmAction,
  ): Promise<void> {
    let meetingId = await this.findMeetingId(ctx.bookingId, credential.integrationId);

    if (!meetingId && action === 'booking_reschedule') {
      // The new-uid reschedule contract: this booking is a fresh row, and the
      // meeting belongs to the one it replaced. ADOPT that meeting onto this
      // booking rather than creating a second — #63 promises one meeting per
      // booking, moved rather than duplicated, and the invitee's contact must
      // not end up holding both a stale meeting at the old time and a new one.
      meetingId = await this.adoptPredecessorMeeting(ctx, credential);
      if (!meetingId) {
        // Nothing was ever written for either booking — e.g. accepted and
        // rescheduled before the write-out drained. A fresh create is the right
        // answer, mirroring `CalendarEffects.moveEvent`.
        await this.writeOut(ctx, credential);
        return;
      }
    }

    if (!meetingId) {
      this.log.debug(`crm ${action} for ${ctx.uid}: never written out — no-op`);
      return;
    }
    const ref = { externalEventId: meetingId };
    const m = getMessages(ctx.hostLocale === 'es' ? 'es' : 'en');
    if (action === 'booking_cancel') {
      await this.crm.updateMeeting({
        token: credential.token,
        meetingId: ref.externalEventId,
        title: prefixCancelledTitle(ctx.title, m.crm.cancelledTitlePrefix),
        outcome: 'canceled',
      });
      return;
    }
    // A reschedule moves the SAME meeting. The title is left alone: a
    // rescheduled meeting is still the same meeting, and rewriting the title
    // would undo a `[Canceled]` prefix if the two ever raced.
    await this.crm.updateMeeting({
      token: credential.token,
      meetingId: ref.externalEventId,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
      outcome: 'scheduled',
    });
  }

  /**
   * The CRM meeting already recorded for a booking, if any.
   *
   * Prefers the reference written by THIS credential. A booking can hold more
   * than one `crm` row — an account that was on the deployment-wide fallback
   * (`crm:env`) and later connected its own portal claims a second destination —
   * and PATCHing a meeting id that belongs to the other portal is a 404 the
   * outbox would then retry five times. An unordered read must not decide which
   * portal we are talking to.
   */
  private async findMeetingId(bookingId: string, integrationId?: string | null): Promise<string | null> {
    const refs = (await loadBookingReferences(this.db, bookingId, 'crm')).filter(
      (r) => r.externalEventId,
    );
    if (refs.length === 0) return null;
    if (integrationId !== undefined) {
      const mine = refs.find((r) => r.destination === crmDestination(integrationId ?? null));
      if (mine) return mine.externalEventId;
    }
    // No reference from THIS credential, but one from another portal (an
    // account that moved off the deployment-wide fallback). Returning it is the
    // better of two bad options: a PATCH that 404s is noisy, but returning null
    // would leave the old portal's meeting standing as `SCHEDULED` forever.
    return refs[0]!.externalEventId;
  }

  /**
   * Carry the predecessor's meeting onto a new-uid reschedule.
   *
   * Walks back through `rescheduledFromUid` — a booking can be moved more than
   * once, and each move mints another row — and when it finds the meeting,
   * claims this booking's destination and records the SAME external id against
   * it. The claim is what keeps a retry of this job from adopting twice; if the
   * claim is already held, the meeting id is read straight back off it.
   *
   * The predecessor's own reference is left in place. It names the same meeting,
   * so it cannot cause a duplicate, and deleting history buys nothing.
   */
  private async adoptPredecessorMeeting(
    ctx: CrmWriteContext,
    credential: { token: string; integrationId: string | null },
  ): Promise<string | null> {
    // Bounded: a reschedule chain is short, and a cycle in the data must not
    // spin the worker.
    const MAX_CHAIN = 10;
    let uid = ctx.rescheduledFromUid;
    let meetingId: string | null = null;
    for (let hop = 0; uid && hop < MAX_CHAIN; hop++) {
      const previous = await loadBookingForCrmWrite(this.db, uid);
      if (!previous) break;
      meetingId = await this.findMeetingId(previous.bookingId, credential.integrationId);
      if (meetingId) break;
      uid = previous.rescheduledFromUid;
    }
    if (!meetingId) return null;

    const destination = crmDestination(credential.integrationId);
    const claimId = await claimBookingDestination(this.db, ctx.bookingId, destination, 'crm');
    if (!claimId) return await this.findMeetingId(ctx.bookingId, credential.integrationId);
    try {
      await fillBookingReference(this.db, claimId, {
        externalEventId: meetingId,
        externalCalendarId: null,
        meetingUrl: null,
      });
    } catch (err) {
      // A claim left held but unfilled is permanent: every later retry would
      // find the claim taken and the id absent, and quietly do nothing forever.
      await releaseBookingReference(this.db, claimId);
      throw err;
    }
    this.log.debug(`crm reschedule for ${ctx.uid}: adopted meeting ${meetingId} from its predecessor`);
    return meetingId;
  }

  /**
   * Create the meeting; on `PROPERTY_DOESNT_EXIST`, drop the named property and
   * retry ONCE (#63). Bounded on purpose: a second unknown property means the
   * portal is shaped in a way this adapter does not understand, and looping
   * would strip the record down to nothing one field at a time.
   */
  private async createMeetingTolerantOfUnknownProperties(
    ctx: CrmWriteContext,
    token: string,
    contactId: string,
  ): Promise<{ meetingId: string }> {
    const m = getMessages(ctx.hostLocale === 'es' ? 'es' : 'en');
    const body = renderMeetingBody({
      hostName: ctx.hostName,
      bookingUid: ctx.uid,
      answers: ctx.answers,
      labels: {
        host: m.crm.hostLabel,
        bookingReference: m.crm.bookingReferenceLabel,
        yes: m.crm.yes,
        no: m.crm.no,
      },
    });
    const input = {
      token,
      contactId,
      title: ctx.title,
      body,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
    };
    try {
      return await this.crm.createMeeting(input);
    } catch (err) {
      if (!(err instanceof CrmPropertyError)) throw err;
      this.log.warn(
        `crm rejected property ${err.propertyName ?? '(unnamed)'} for ${ctx.uid}; retrying without the body`,
      );
      // The body is the only optional property we send; everything else is
      // required for a meeting to exist at all — so if the retry is rejected
      // too, the portal is shaped in a way this adapter cannot satisfy and no
      // amount of backoff will change that. Record it once with a reason rather
      // than burning five attempts on it, exactly as a missing scope is handled.
      try {
        return await this.crm.createMeeting({ ...input, body: '' });
      } catch (retryErr) {
        if (retryErr instanceof CrmPropertyError) {
          throw new OutboxSkipError(
            `${this.crm.name} rejected property ${retryErr.propertyName ?? '(unnamed)'}, which this integration cannot omit`,
          );
        }
        throw retryErr;
      }
    }
  }
}
