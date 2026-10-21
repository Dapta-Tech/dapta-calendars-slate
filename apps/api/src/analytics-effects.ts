import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { enqueueOutbox, sql, type Db } from '@slate/db';
import type { ServerEnv } from '@slate/config/env';
import {
  ANALYTICS_PRODUCT,
  analyticsCampaignValue,
  analyticsEventName,
  isInternalEmail,
  parseInternalEmailPatterns,
  referrerDomain,
  type AnalyticsProps,
  type ServerAnalyticsEvent,
} from '@slate/shared';
import type { AttributionInput } from '@slate/types';
import {
  AnalyticsRejectedError,
  type AnalyticsAccountUpdate,
  type AnalyticsCapture,
  type AnalyticsProvider,
} from './analytics.provider';
import type { SignupNotice, SignupObserver } from './auth.provider';
import { OutboxSkipError } from './email-effects';
import { ANALYTICS, DB, ENV } from './tokens';

/** What an `analytics` outbox row carries: exactly one call to the port. */
type AnalyticsOutboxPayload =
  | { type: 'capture'; capture: AnalyticsCapture }
  | { type: 'account'; update: AnalyticsAccountUpdate };

/** The member and account a host event is about, resolved in one read. */
interface HostIdentity {
  accountId: string;
  email: string;
  accountKey: string;
  isInternal: boolean;
}

/** Longest string property sent. Properties are labels, never free text. */
const PROPERTY_MAX = 200;

/**
 * Flat primitives only, strings clamped: no caller can ship a paragraph or an
 * object by mistake, whatever a request body handed it.
 */
function bounded(properties: AnalyticsProps): AnalyticsProps {
  const out: AnalyticsProps = {};
  for (const [k, v] of Object.entries(properties)) {
    if (typeof v === 'string') out[k] = v.slice(0, PROPERTY_MAX);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

/**
 * A short machine label (a provider key, say), or `other`. For values that
 * arrive from a request body or a backend: an identifier is kept, free text
 * never is.
 */
export function analyticsLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9._-]{1,40}$/.test(label) ? label : 'other';
}

/**
 * Attempts per analytics row. Fewer than the outbox default, and analytics
 * rows have no retry horizon (see `NO_RETRY_HORIZON` in outbox.worker.ts): a
 * lost event is acceptable here, a vendor hammered for a day is not. They
 * drain in their own lane, so a vendor that hangs holds nothing else up.
 */
const ANALYTICS_MAX_ATTEMPTS = 3;

/** How a booking reached the API, for `booking_created`. */
export type BookingChannel = 'booking_page' | 'host' | 'api';

/**
 * Durable PRODUCT ANALYTICS, the API half (mirrors CrmEffects / EmailEffects).
 *
 * Every event is ENQUEUED as an `outbox` row (kind `analytics`) and delivered
 * by the worker with retry and backoff, never inline: `booking_created` fires
 * on the public booking path, and a slow analytics vendor must never delay or
 * fail a visitor's booking.
 *
 * With analytics off (no provider: every bare fork) every method returns at
 * once. Nothing is read, nothing is enqueued, nothing is sent.
 *
 * Privacy is decided HERE rather than at each call site:
 *  - the distinct id is always a HOST's email, never a visitor's;
 *  - a visitor's email is used only to compute two booleans
 *    (`invitee_is_member`, `invitee_is_internal`) and is never serialized;
 *  - call sites pass flat, non-personal properties (ids of choices, counts,
 *    flags); a referrer is reduced to its domain.
 */
@Injectable()
export class AnalyticsEffects {
  private readonly log = new Logger('AnalyticsEffects');
  private readonly internalPatterns: string[];
  /** The deployment's public host, so server events filter like browser ones. */
  private readonly host: string | null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(ANALYTICS) private readonly provider: AnalyticsProvider | null = null,
    @Optional() @Inject(ENV) env?: ServerEnv,
  ) {
    this.internalPatterns = parseInternalEmailPatterns(env?.PRODUCT_ANALYTICS_INTERNAL_EMAILS);
    this.host = /^https?:\/\/([^/?#]+)/i.exec(env?.PUBLIC_APP_URL ?? '')?.[1]?.toLowerCase() ?? null;
  }

  /** True when this deployment has product analytics configured at all. */
  get enabled(): boolean {
    return this.provider !== null;
  }

  /**
   * One event about a signed-in host. NEVER REJECTS: callers may `void` it.
   *
   * The identity comes from the resolved principal and the database, never
   * from request input, so nobody can file activity under someone else. A
   * member with no email on file is dropped rather than captured under a
   * made-up id, which would merge unrelated people into one.
   */
  async hostEvent(
    event: ServerAnalyticsEvent,
    principal: { accountId: string; memberId: string },
    properties: AnalyticsProps = {},
    now: number = Date.now(),
  ): Promise<void> {
    if (!this.provider) return;
    try {
      const who = await this.identity(principal.accountId, principal.memberId, event);
      if (!who) return;
      await this.enqueueCapture(event, who, properties, now);
    } catch (err) {
      this.log.error(`analytics ${event} not recorded: ${String(err)}`);
    }
  }

  /** The signup observer the auth providers are given. */
  readonly onSignup: SignupObserver = (signup) => {
    void this.signup(signup);
  };

  /** A member came into being; a first member also describes the new account. */
  async signup(signup: SignupNotice, now: number = Date.now()): Promise<void> {
    if (!this.provider) return;
    try {
      const who = await this.identity(signup.accountId, signup.memberId, 'signup_completed');
      if (!who) return;
      await this.enqueueCapture(
        'signup_completed',
        who,
        { role: signup.role, is_first_member: signup.isFirstMember, from_invite: signup.fromInvite },
        now,
        { email: who.email, is_internal: who.isInternal },
      );
      // A login that adopted an invitation in the token's own account accepted
      // it: the same fact the dashboard's explicit acceptance reports.
      if (signup.fromInvite) await this.enqueueCapture('invite_accepted', who, { role: signup.role }, now);
      // The account's own facts. `is_internal` here is the FOUNDER's, so an
      // operator who later visits a customer's workspace never marks the
      // customer's account as internal.
      if (signup.isFirstMember) {
        await this.enqueueAccount(who, { is_internal: who.isInternal, created_at: new Date(now).toISOString() }, now);
      }
    } catch (err) {
      this.log.error(`analytics signup not recorded: ${String(err)}`);
    }
  }

  /**
   * The first-touch campaign tags were claimed onto the account: the signup
   * source. Sent as an event (for "signups by source") and as account
   * properties (so every later step of an account can be split by source).
   * Paid click ids are reduced to a flag: a per-click id is useless for
   * grouping and needless data to hand a third party.
   */
  async attributionCaptured(
    principal: { accountId: string; memberId: string },
    attribution: AttributionInput,
    now: number = Date.now(),
  ): Promise<void> {
    if (!this.provider) return;
    try {
      const who = await this.identity(principal.accountId, principal.memberId, 'attribution_captured');
      if (!who) return;
      const source: AnalyticsProps = {};
      // A tag that is an address, a URL or a query is withheld, not sent (see
      // `analyticsCampaignValue`); the event says one was, so the gap is visible.
      let withheld = false;
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const) {
        const raw = attribution[key];
        if (typeof raw !== 'string' || !raw) continue;
        const value = analyticsCampaignValue(raw);
        if (value) source[key] = value;
        else withheld = true;
      }
      const domain = referrerDomain(attribution.referer);
      if (domain) source.referrer_domain = domain;
      await this.enqueueCapture(
        'attribution_captured',
        who,
        {
          ...source,
          has_click_id: Boolean(attribution.gclid || attribution.fbclid),
          ...(withheld ? { utm_withheld: true } : {}),
        },
        now,
      );
      // The account says so too: an account whose every tag was withheld would
      // otherwise read as one that arrived with none.
      if (withheld) source.utm_withheld = true;
      if (Object.keys(source).length > 0) await this.enqueueAccount(who, source, now);
    } catch (err) {
      this.log.error(`analytics attribution not recorded: ${String(err)}`);
    }
  }

  /**
   * A booking was created. About the HOST who received it: the visitor is not
   * identified, and their email only decides two booleans, here, in memory.
   */
  async bookingCreated(
    booking: { uid: string; inviteeEmail: string | null | undefined; channel: BookingChannel; isTeam: boolean },
    now: number = Date.now(),
  ): Promise<void> {
    if (!this.provider) return;
    try {
      const row = await this.db.get<{ account_id: string; host_member_id: string | null; status: string }>(
        sql`SELECT account_id, host_member_id, status FROM booking WHERE uid = ${booking.uid} LIMIT 1`,
      );
      if (!row?.host_member_id) {
        // Unreadable right after the write (a lagging replica) or a booking
        // with no single host: said, so an undercount is never silent.
        this.log.warn(`analytics booking_created dropped: booking ${booking.uid} has no readable host`);
        return;
      }
      const who = await this.identity(row.account_id, row.host_member_id, 'booking_created');
      if (!who) return;
      const invitee = booking.inviteeEmail?.trim() ?? '';
      const member = invitee
        ? await this.db.get<{ id: string }>(
            sql`SELECT id FROM member
                 WHERE account_id = ${row.account_id} AND lower(email) = lower(${invitee}) LIMIT 1`,
          )
        : undefined;
      await this.enqueueCapture(
        'booking_created',
        who,
        {
          channel: booking.channel,
          status: row.status,
          is_team: booking.isTeam,
          invitee_is_member: Boolean(member),
          invitee_is_internal: isInternalEmail(invitee, this.internalPatterns),
        },
        now,
      );
    } catch (err) {
      this.log.error(`analytics booking_created not recorded: ${String(err)}`);
    }
  }

  /**
   * The worker's executor for an `analytics` outbox row. A row left behind
   * after analytics was turned off is skipped once, never retried; so is an
   * event the vendor refused, since it will be refused the same way forever.
   */
  async deliver(_action: string, payload: string | null): Promise<void> {
    if (!this.provider) throw new OutboxSkipError('analytics is not configured');
    // A row that cannot be read now never will be: skipped once, not retried.
    let message: AnalyticsOutboxPayload;
    try {
      message = JSON.parse(payload ?? '') as AnalyticsOutboxPayload;
    } catch {
      throw new OutboxSkipError('analytics outbox row has an unreadable payload');
    }
    if (message?.type !== 'account' && message?.type !== 'capture') {
      throw new OutboxSkipError('analytics outbox row has an unknown type');
    }
    try {
      if (message.type === 'account') await this.provider.updateAccount(message.update);
      else await this.provider.capture(message.capture);
    } catch (err) {
      if (err instanceof AnalyticsRejectedError) throw new OutboxSkipError(err.message);
      throw err;
    }
  }

  /* ------------------------------------------------------------ internal */

  private async identity(accountId: string, memberId: string, event: ServerAnalyticsEvent): Promise<HostIdentity | null> {
    const row = await this.db.get<{ email: string | null; code: string }>(
      sql`SELECT m.email AS email, a.code AS code
            FROM member m JOIN account a ON a.id = m.account_id
           WHERE m.id = ${memberId} AND m.account_id = ${accountId} LIMIT 1`,
    );
    // A member just written can be unreadable on a lagging replica: dropped,
    // but said, so an undercount is never silent. No email is a normal state
    // (an invite not yet answered) and drops quietly.
    if (!row) {
      this.log.warn(`analytics ${event} dropped: member ${memberId} not readable`);
      return null;
    }
    if (!row.email) return null;
    return {
      accountId,
      email: row.email,
      // The SHORT code, which never changes: the public code a page shows can
      // become a vanity slug, and a group key that moved would split an
      // account's history in two.
      accountKey: row.code,
      isInternal: isInternalEmail(row.email, this.internalPatterns),
    };
  }

  private async enqueueCapture(
    event: ServerAnalyticsEvent,
    who: HostIdentity,
    properties: AnalyticsProps,
    now: number,
    personSet?: AnalyticsProps,
  ): Promise<void> {
    const name = analyticsEventName(event);
    const capture: AnalyticsCapture = {
      uuid: randomUUID(),
      event: name,
      distinctId: who.email,
      // Stamped at ENQUEUE time: the row may drain much later, and the drain
      // time would smear the funnel and put events out of order.
      timestamp: now,
      properties: {
        ...bounded(properties),
        product: ANALYTICS_PRODUCT,
        is_internal: who.isInternal,
        account_code: who.accountKey,
        ...(this.host ? { $host: this.host } : {}),
      },
      ...(personSet ? { personSet } : {}),
      accountKey: who.accountKey,
    };
    await this.enqueue(name, who.accountId, { type: 'capture', capture }, now);
  }

  private async enqueueAccount(who: HostIdentity, properties: AnalyticsProps, now: number): Promise<void> {
    const update: AnalyticsAccountUpdate = {
      uuid: randomUUID(),
      distinctId: who.email,
      timestamp: now,
      accountKey: who.accountKey,
      properties: { ...bounded(properties), account_code: who.accountKey },
    };
    await this.enqueue('$groupidentify', who.accountId, { type: 'account', update }, now);
  }

  private async enqueue(
    action: string,
    accountId: string,
    payload: AnalyticsOutboxPayload,
    now: number,
  ): Promise<void> {
    await enqueueOutbox(this.db, {
      kind: 'analytics',
      action,
      accountId,
      payload: JSON.stringify(payload),
      maxAttempts: ANALYTICS_MAX_ATTEMPTS,
      now,
    });
  }
}
