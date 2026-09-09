import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  listWebhookDeliveries,
  checkHandleAvailable,
  confirmBooking,
  createApiKey,
  createBooking,
  createConnection,
  updateConnection,
  connectionExists,
  countPublishedEventTypes,
  getConnectionRef,
  getMemberIdentity,
  declineBooking,
  createWebhook,
  updateWebhook,
  pingWebhook,
  deleteConnection,
  deleteWebhook,
  ensureDefaultSchedule,
  enqueueWebhookDeliveries,
  getAvailability,
  getMe,
  getSchedule,
  listApiKeys,
  listBookings,
  listAccountIntegrations,
  type IntegrationStatusRow,
  disconnectAccountIntegration,
  loadEncryptionKey,
  upsertAccountIntegration,
  listConnections,
  listSchedules,
  listWebhooks,
  recordConnectionHealth,
  revokeApiKey,
  setConnectionPrimaryEmail,
  updateBranding,
  updateHandle,
  updateMemberSettings,
  updateSchedule,
  cancelBooking,
  cacheEntitlement,
  setVanitySlug,
  sql,
  type VanityOutcome,
  defaultNotificationSetting,
  getNotificationSettings,
  resetNotificationTemplate,
  upsertNotificationSetting,
} from '@slate/db';
import {
  ACCOUNT_TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  defaultEnabledFor,
  defaultTemplate,
  renderTemplate,
  resolveTemplate,
  templateVars,
  unknownTokens,
  type BookingNotification,
  type EmailTemplateKey,
} from '@slate/notifications';
import { canClaimVanitySlug } from '@slate/engine';
import { CrmAuthError } from '@slate/crm';
import type {
  IntegrationCapabilities,
  IntegrationConnectInput,
  IntegrationStatusView,
} from '@slate/types';
import { getMessages } from '@slate/shared';
import type { ServerEnv } from '@slate/config/env';
import type { HostPrincipal } from './auth.service';
import { CalendarEffects } from './calendar-effects';
import { CrmEffects } from './crm-effects';
import { asConnector } from './calendar.http-provider';
import { EmailEffects } from './email-effects';
import { DisabledEntitlementsProvider, type EntitlementsProvider } from './entitlements.provider';
import { DB, ENTITLEMENTS, ENV, PREMIUM_MODE } from './tokens';

/** How long a cached Dapta AI entitlement verdict stays fresh before re-asking upstream. */
const ENTITLEMENT_TTL_MS = 6 * 3600_000;

/** Authed host/dashboard operations. All are scoped to the caller's account. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
    @Inject(EmailEffects) private readonly email: EmailEffects,
    // Optional so existing direct constructions keep working: OSS default is
    // no upstream + `open` premium mode (fork-friendly).
    @Optional() @Inject(ENTITLEMENTS) private readonly entitlements: EntitlementsProvider = new DisabledEntitlementsProvider(),
    @Optional() @Inject(PREMIUM_MODE) private readonly premiumMode: 'open' | 'locked' = 'open',
    // Optional (specs construct this service directly): only used to build the
    // attendee manage link on host-created bookings.
    @Optional() @Inject(ENV) private readonly env?: ServerEnv,
    // H1a: the CRM write-out rides the SAME lifecycle transitions as the
    // calendar one, as its own enqueue — no-op when CRM_PROVIDER=disabled,
    // which is the OSS default. LAST and @Optional() so the many specs that
    // construct this service positionally keep working: absent, the booking
    // lifecycle simply enqueues no CRM row, which is exactly what those specs
    // (and a bare fork) already expect.
    @Optional() @Inject(CrmEffects) private readonly crm?: CrmEffects,
  ) {}

  async me(p: HostPrincipal) {
    // Hard invariant: a host must never resolve to NO_SCHEDULE — see
    // ensureDefaultSchedule. Cheap (one indexed SELECT) once a default exists.
    // The onboarding gates are NOT read here: OnboardingService is their single
    // authority (it also decides whether gate 1 applies to this deployment at
    // all), and HostController.me composes the two onto one response.
    await ensureDefaultSchedule(this.db, p.accountId, p.memberId);
    return getMe(this.db, p.accountId, p.memberId);
  }

  /**
   * One-time browser-timezone catch-up (Home first-run guide / admin layout,
   * fired once on mount). Only takes effect while the member is still on the
   * raw schema default ('UTC', never explicitly chosen) — a member who has
   * explicitly picked a timezone in Settings → General is never silently
   * overridden. Also re-times the auto-created default schedule so "Working
   * hours" isn't stuck on UTC once the real timezone is known.
   */
  async syncClientTimeZone(p: HostPrincipal, timeZone: string): Promise<{ ok: boolean }> {
    if (!timeZone || timeZone === 'UTC') return { ok: false };
    const member = await this.db.get<{ time_zone: string; default_schedule_id: string | null }>(
      sql`SELECT time_zone, default_schedule_id FROM member WHERE id = ${p.memberId} LIMIT 1`,
    );
    if (!member || member.time_zone !== 'UTC') return { ok: false }; // already explicit — never override
    await updateMemberSettings(this.db, p.memberId, { timeZone });
    if (member.default_schedule_id) {
      const sched = await getSchedule(this.db, p.accountId, member.default_schedule_id);
      if (sched && sched.timeZone === 'UTC') {
        await updateSchedule(this.db, p.accountId, member.default_schedule_id, { timeZone });
      }
    }
    return { ok: true };
  }

  /**
   * The Home "Get bookable" checklist (R22: real data, not a static nag) —
   * three steps: a connected calendar, working hours (a default schedule with
   * ≥1 rule), and at least one PUBLISHED event type.
   *
   * That third step used to be `hasBookingLink: !!me?.handle`, and it lied to
   * every host in the product. Every member is given an auto-handle at creation
   * (short-links §3), so the flag was true from the first second of an account's
   * life — the checklist reported "you are bookable" while the host's public
   * page rendered an empty list with nothing to book. The measure is now the
   * thing the step is actually about: does this host own a published event type
   * (ADR 0002 → Consequences, #84).
   */
  async setupStatus(p: HostPrincipal): Promise<{
    hasConnectedCalendar: boolean;
    hasWorkingHours: boolean;
    hasPublishedEventType: boolean;
  }> {
    const [connections, schedules, publishedEventTypes] = await Promise.all([
      listConnections(this.db, p.memberId),
      listSchedules(this.db, p.memberId),
      countPublishedEventTypes(this.db, p.accountId, p.memberId),
    ]);
    let hasWorkingHours = false;
    if (schedules.length > 0) {
      const rule = await this.db.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM availability WHERE schedule_id IN (
              SELECT id FROM schedule WHERE member_id = ${p.memberId}
            )`,
      );
      hasWorkingHours = Number(rule?.n ?? 0) > 0;
    }
    return {
      hasConnectedCalendar: connections.length > 0,
      hasWorkingHours,
      hasPublishedEventType: publishedEventTypes > 0,
    };
  }

  handleAvailable(p: HostPrincipal, handle: string) {
    return checkHandleAvailable(this.db, p.accountId, handle, p.memberId);
  }

  updateBranding(p: HostPrincipal, patch: Parameters<typeof updateBranding>[2]) {
    return updateBranding(this.db, p.memberId, patch);
  }

  updateSettings(p: HostPrincipal, patch: Parameters<typeof updateMemberSettings>[2]) {
    return updateMemberSettings(this.db, p.memberId, patch);
  }

  /** Rename the handle after confirming it's available (reserved/taken → error). */
  async renameHandle(p: HostPrincipal, handle: string): Promise<{ ok: boolean; reason: string | null }> {
    const check = await checkHandleAvailable(this.db, p.accountId, handle, p.memberId);
    if (!check.available) return { ok: false, reason: check.reason };
    await updateHandle(this.db, p.memberId, check.handle);
    return { ok: true, reason: null };
  }

  // Host bookings (R29): the on-behalf path with the singular-attendee shape.
  listBookings(p: HostPrincipal, q: { from?: string; to?: string; status?: string; limit?: number }) {
    return listBookings(this.db, {
      accountId: p.accountId,
      memberId: p.memberId,
      from: q.from ? new Date(q.from).getTime() : undefined,
      to: q.to ? new Date(q.to).getTime() : undefined,
      status: q.status,
      limit: q.limit,
    });
  }

  async hostCreate(
    p: HostPrincipal,
    body: {
      handle?: string;
      slug: string;
      startUtc: string;
      attendee: { name: string; email: string; timeZone: string; notes?: string; phone?: string };
      answers?: Record<string, unknown>;
    },
    accountCode: string,
  ) {
    const outcome = await createBooking(
      this.db,
      {
        accountCode,
        // Hosts can create manual bookings before setting a public handle: fall
        // back to their own member id when no handle is on the payload.
        handle: body.handle || undefined,
        memberId: body.handle ? undefined : p.memberId,
        slug: body.slug,
        startMs: new Date(body.startUtc).getTime(),
        attendee: body.attendee,
        answers: body.answers,
        onBehalf: true,
      },
      // Fail-closed external conflict check at create time (no-op when disabled).
      this.calendar.provider,
    );
    // Write out only a fresh ACCEPTED booking (pending waits for confirm).
    if (outcome.ok && outcome.booking.status === 'accepted') {
      this.calendar.onBookingAccepted(outcome.booking.uid);
      this.crm?.onBookingAccepted(outcome.booking.uid);
    }
    // QA2 BUG-1 — same bug develop's 7305d09 fixed; merged as the superset:
    // this path created the booking but notified NOBODY while the UI claimed
    // "the attendee has been notified". Mirror the public path's side-effects,
    // gated on manageToken so an idempotent replay re-sends nothing: emails
    // carry the attendee manage link, PENDING bookings get the
    // request-received mail, and booking.created webhooks fire for both.
    if (outcome.ok && outcome.manageToken) {
      const b = outcome.booking;
      const manageUrl = this.env
        ? `${this.env.PUBLIC_APP_URL}/manage/${b.uid}?token=${outcome.manageToken}`
        : undefined;
      if (b.status === 'accepted') {
        void this.email.enqueueConfirmation(b.uid, { manageUrl });
        void this.email.enqueueReminders(b.uid, { manageUrl });
        void this.email.enqueueFollowUps(b.uid, { manageUrl });
      } else if (b.status === 'pending') {
        void this.email.enqueuePending(b.uid, { manageUrl });
      }
      void enqueueWebhookDeliveries(this.db, p.accountId, 'booking.created', {
        uid: b.uid,
        status: b.status,
        startUtc: new Date(b.startMs).toISOString(),
        endUtc: new Date(b.endMs).toISOString(),
        title: b.title,
      }).catch(() => undefined);
    }
    return outcome;
  }

  async hostCancel(p: HostPrincipal, uid: string, reason?: string) {
    const out = await cancelBooking(this.db, { uid, reason, byHost: true, accountId: p.accountId });
    // B2: the host-dashboard cancel bypassed BookingService and sent NOTHING.
    // Now it deletes the remote event, emails the attendee (+ host), and fires
    // the webhook — all durably via the outbox. Skip side-effects on an
    // idempotent retry (already cancelled) so nothing is duplicated (P1-1).
    if (out.ok && !out.alreadyApplied) {
      this.calendar.onBookingCancelled(uid);
      this.crm?.onBookingCancelled(uid);
      void this.email.enqueueCancellation(uid, { reason: reason ?? null });
      // The booking is off — its still-pending reminders must never fire.
      // (The public cancel path already did this; the host path missed it.)
      void this.email.cancelReminders(uid);
      void this.email.cancelFollowUps(uid);
      void enqueueWebhookDeliveries(this.db, p.accountId, 'booking.cancelled', {
        uid,
        reason: reason ?? null,
      }).catch(() => undefined);
    }
    return out;
  }

  async confirm(p: HostPrincipal, uid: string) {
    const out = await confirmBooking(this.db, uid, p.accountId);
    if (out.ok) {
      // pending→accepted: NOW write the event to the host's calendar and send
      // the attendee the confirmation (they already hold the manage link from
      // the "request received" email; the token isn't retrievable here).
      this.calendar.onBookingAccepted(uid);
      this.crm?.onBookingAccepted(uid);
      void this.email.enqueueConfirmation(uid);
      // Now that it's confirmed, schedule its pre-meeting reminders.
      void this.email.enqueueReminders(uid);
      void this.email.enqueueFollowUps(uid);
      void enqueueWebhookDeliveries(this.db, p.accountId, 'booking.confirmed', { uid }).catch(
        () => undefined,
      );
    }
    return out;
  }

  async decline(p: HostPrincipal, uid: string, reason?: string) {
    const out = await declineBooking(this.db, uid, reason, p.accountId);
    if (out.ok) {
      // B3: tell the attendee their pending request was declined (previously
      // nobody was notified — they'd show up to a meeting that never was).
      void this.email.enqueueDeclined(uid, { reason: reason ?? null });
      // Safety: drop any reminders (a declined pending booking usually has none).
      void this.email.cancelReminders(uid);
      void this.email.cancelFollowUps(uid);
      void enqueueWebhookDeliveries(this.db, p.accountId, 'booking.cancelled', {
        uid,
        reason: reason ?? null,
      }).catch(() => undefined);
    }
    return out;
  }

  // Connections (behind the CalendarProvider port — generic).
  /**
   * List connections, best-effort backfilling any missing `primaryEmail` so
   * the UI can always show WHICH account a row is (critical once a member has
   * more than one calendar). Older/seeded rows can predate the "which
   * account?" email step, or a discovery run whose provider response omitted
   * it — derive it the same way `discoverConnections` does (the provider's
   * primary calendar id IS the account email) and persist it once so future
   * reads are free. Never blocks or fails the read: an unreachable provider
   * just leaves the row as-is (the UI falls back to "account unknown").
   */
  // --- H1a: CRM integrations (#63 / ADR 0001) ------------------------------
  //
  // Three admin operations, no UI (that is H1b / #93). Every one resolves the
  // principal upstream and is scoped to `p.accountId` — a credential is an
  // ACCOUNT-level resource, so it is `assertAdmin` at the controller and
  // account-scoped here (invariant 4).
  //
  // The token travels in only. Nothing any of these returns carries it, or the
  // cipher: `IntegrationStatusView` is the whole of what a client may see.

  /** Status rows for the account's integrations. Never carries a credential. */
  async listIntegrations(p: HostPrincipal): Promise<IntegrationStatusView[]> {
    const rows = await listAccountIntegrations(this.db, p.accountId);
    return rows.map(toIntegrationView);
  }

  /**
   * What this DEPLOYMENT can do — not what this account has done (H1b / #93).
   *
   * `connectIntegration` refuses on two deployment states: no adapter selected
   * (`CRM_DISABLED`) and no encryption key (`INTEGRATION_KEY_MISSING`). Neither
   * is discoverable from a browser except by pasting a credential and being
   * turned away, which is a bad trade when the paste is preceded by a trip to
   * the provider's portal. So the UI asks up front and disables Connect.
   *
   * Booleans only. The key itself, its length, and the provider's own config
   * stay on this side — the answer says WHETHER, never WHAT.
   */
  integrationCapabilities(_p: HostPrincipal): IntegrationCapabilities {
    const provider = this.crm?.provider;
    const enabled = provider?.enabled === true;
    let canStoreCredentials = false;
    try {
      loadEncryptionKey(this.env?.INTEGRATION_ENCRYPTION_KEY);
      canStoreCredentials = true;
    } catch {
      /* absent or malformed — either way the answer is the same: no */
    }
    return {
      provider: enabled ? (provider?.name ?? null) : null,
      enabled,
      canStoreCredentials,
      // From the ADAPTER, never from a copy catalog: the checklist a host works
      // through and the scopes the adapter actually needs are one list.
      requiredScopes: enabled ? [...(provider?.requiredScopes ?? [])] : [],
    };
  }

  /**
   * Connect a credential: VERIFY FIRST, store only on success (fail-closed).
   *
   * #63 rejected introspecting the token for its scope list — that endpoint is
   * documented only in community threads and has an EU-token quirk, and resting
   * the connect gate on it is fragile. So we simply use the credential: if the
   * read works, the token is real and carries the scopes this integration
   * needs; if it 403s, the reply names the scopes that are missing (#74), and
   * they go back to the caller as DATA rather than prose.
   */
  async connectIntegration(
    p: HostPrincipal,
    input: IntegrationConnectInput,
  ): Promise<IntegrationStatusView> {
    const provider = this.crm?.provider;
    if (!provider?.enabled || provider.name !== input.provider) {
      throw new BadRequestException({
        error: 'CRM_DISABLED',
        message: `No ${input.provider} integration is enabled on this deployment (set CRM_PROVIDER).`,
      });
    }
    // Loud, not silent: refusing is the only honest alternative to writing a
    // customer's CRM credential to disk in plaintext. Translated to a coded
    // reply rather than left to surface as a bare 500 — "the operator has not
    // set a key" and "the CRM is unreachable" need different actions from
    // whoever is looking at the screen.
    let key: Buffer;
    try {
      key = loadEncryptionKey(this.env?.INTEGRATION_ENCRYPTION_KEY);
    } catch {
      throw new ServiceUnavailableException({
        error: 'INTEGRATION_KEY_MISSING',
        message:
          'This deployment cannot store integration credentials: INTEGRATION_ENCRYPTION_KEY is not configured.',
      });
    }

    try {
      await provider.verifyCredential({ token: input.token });
    } catch (err) {
      if (err instanceof CrmAuthError) {
        throw new UnprocessableEntityException({
          error: 'INTEGRATION_REJECTED',
          message: 'That token was rejected. Check the private app\'s scopes and try again.',
          requiredGranularScopes: err.requiredGranularScopes,
          category: err.category,
        });
      }
      // Reachable upstream, unreachable right now. Nothing is stored: a
      // credential we could not verify is a credential we do not keep.
      throw new BadRequestException({
        error: 'INTEGRATION_UNVERIFIED',
        message: 'Could not reach the CRM to verify that token. Try again in a moment.',
      });
    }

    const row = await upsertAccountIntegration(this.db, {
      accountId: p.accountId,
      provider: input.provider,
      token: input.token,
      key,
      label: input.label ?? null,
    });
    return toIntegrationView(row);
  }

  /**
   * Disconnect: scrub the credential, keep the row (and therefore its id).
   * Pending write-out is marked `skipped` — the user reversed a decision, they
   * did not suffer a delivery failure. Nothing is deleted in the CRM.
   */
  async disconnectIntegration(p: HostPrincipal, provider: string): Promise<{ disconnected: boolean }> {
    const disconnected = await disconnectAccountIntegration(this.db, p.accountId, provider);
    return { disconnected };
  }

  async listConnections(p: HostPrincipal) {
    const rows = (await listConnections(this.db, p.memberId)).map((c) => ({
      ...c,
      // ADR 0008: the running product names the conferencing platform, the repo
      // never does. Null on a bare fork ⇒ the editor shows generic wording.
      conferencingLabel: this.provider.conferencingLabel ?? null,
    }));
    if (!this.provider.enabled) return rows;
    // Backfill missing primaryEmail in small batches (optibot #32 fix): an
    // unbounded Promise.all here would fan out one provider call PER
    // un-backfilled row on a single page load — fine for the handful a member
    // normally has, but with many stale rows it can hammer the provider's own
    // rate limit. A page load is not latency-sensitive enough to need full
    // parallelism; a small concurrency cap keeps the win (no serial N-deep
    // wait) without the fan-out risk.
    const BACKFILL_CONCURRENCY = 4;
    const toBackfill = rows.filter((c) => !c.primaryEmail);
    for (let i = 0; i < toBackfill.length; i += BACKFILL_CONCURRENCY) {
      await Promise.all(
        toBackfill.slice(i, i + BACKFILL_CONCURRENCY).map(async (c) => {
          try {
            const calendars = await this.provider.listCalendars(c.externalId);
            const email =
              calendars.find((cal) => cal.isPrimary)?.primaryEmail ??
              calendars.find((cal) => cal.primaryEmail)?.primaryEmail ??
              null;
            if (email) {
              await setConnectionPrimaryEmail(this.db, p.memberId, c.id, email);
              c.primaryEmail = email;
            }
          } catch {
            /* best-effort — leave null */
          }
        }),
      );
    }
    return rows;
  }
  createConnection(p: HostPrincipal, body: { provider: string; externalId: string; primaryEmail?: string; isDestination?: boolean; checkConflicts?: boolean }) {
    return createConnection(this.db, { accountId: p.accountId, memberId: p.memberId, ...body });
  }
  deleteConnection(p: HostPrincipal, id: string) {
    return deleteConnection(this.db, p.memberId, id);
  }
  updateConnection(p: HostPrincipal, id: string, patch: { isDestination?: boolean; checkConflicts?: boolean }) {
    return updateConnection(this.db, p.memberId, id, patch);
  }

  /** The wired calendar provider (from the effects seam). */
  private get provider() {
    return this.calendar.provider;
  }

  /**
   * Start a connect flow: mint the connect token/URL from the provider. Returns
   * an honest disabled status when no external provider is wired (OSS default),
   * so the UI can say so instead of silently failing.
   *
   * The connect subject is keyed by the Dapta-platform identity behind this
   * member (`getMemberIdentity` — the upstream IAM user id), not the member's
   * own local id: the rest of Dapta (adminpanel/flow-runner) keys the SAME
   * external credential broker with `${iamUserId}-${accountEmail}` (a distinct
   * subject per connected account — this is how a Dapta user already connects
   * more than one Google account today, verified live against real accounts
   * with 2-5 calendar connections each). Matching that scheme is what makes an
   * account connected in the main Dapta app show up here automatically (and
   * vice versa), and what lets a member add a 2nd/3rd calendar here: each
   * `email` is a DIFFERENT subject, so the "one connection per subject" rule
   * upstream never collides across accounts. `email` is the account the host
   * is ABOUT to connect (collected by the caller before this call, mirroring
   * adminpanel's own "which account?" prompt) — omitted only for the cheap
   * enabled/disabled probe (`ConnectionsPage`), which never uses the resulting
   * connectUrl.
   */
  async connectionToken(
    p: HostPrincipal,
    provider: string,
    email?: string,
  ): Promise<{ enabled: boolean; token: string | null; connectUrl: string | null; message: string }> {
    const connector = asConnector(this.provider);
    if (!connector) {
      return {
        enabled: false,
        token: null,
        connectUrl: null,
        message: 'No external calendar provider configured (OSS default). Add a connection manually.',
      };
    }
    const identity = await getMemberIdentity(this.db, p.memberId);
    const iamUserId = identity?.iamUserId ?? p.memberId;
    const subject = email ? `${iamUserId}-${email}` : iamUserId;
    const start = await connector.startConnect(provider, subject);
    return { enabled: true, token: start.token, connectUrl: start.connectUrl, message: 'Connect started.' };
  }

  /**
   * After the OAuth popup completes, discover the tenant's connection(s) for the
   * provider and persist any not already stored (first destination wins R20).
   * Returns the connections now on record.
   *
   * Discovery is keyed by the PLAIN Dapta iamUserId (no email suffix) so it
   * enumerates EVERY account subject this member owns
   * (`${iamUserId}-<email1>`, `${iamUserId}-<email2>`, …) — including accounts
   * connected from the main Dapta app before this member ever opened
   * Calendars, and every prior connection of this member's own (legacy plain
   * `iamUserId` subjects, pre-dating the per-email scheme, keep matching too).
   */
  async discoverConnections(p: HostPrincipal, provider: string, email?: string) {
    const connector = asConnector(this.provider);
    if (!connector) return listConnections(this.db, p.memberId);
    const identity = await getMemberIdentity(this.db, p.memberId);
    const iamUserId = identity?.iamUserId ?? p.memberId;
    // Membrane keys each connected account by the COMPOSITE subject
    // `${iamUserId}-${email}` (the SAME scheme the main Dapta app uses — proven
    // against the live workspace). A tenant token is an EXACT customerId match,
    // so querying the bare `iamUserId` alone never sees a `${iamUserId}-<email>`
    // account. Enumerate every subject this member could own and union them:
    //   - the account just connected (the `email` arg from the connect step),
    //   - the member's own login email (surfaces a calendar connected elsewhere
    //     in Dapta under the same identity — e.g. the main app),
    //   - the bare `iamUserId` (legacy pre-per-email connections).
    const subjects = new Set<string>();
    if (email) subjects.add(`${iamUserId}-${email}`);
    if (identity?.email) subjects.add(`${iamUserId}-${identity.email}`);
    subjects.add(iamUserId);
    const perSubject = await Promise.all(
      [...subjects].map((s) => connector.discoverConnections(s, provider).catch(() => [])),
    );
    const discoveredByRef = new Map<string, (typeof perSubject)[number][number]>();
    for (const conn of perSubject.flat()) discoveredByRef.set(conn.connectionRef, conn);
    const discovered = [...discoveredByRef.values()];
    const haveDestination = (await listConnections(this.db, p.memberId)).some((c) => c.isDestination);
    let firstNew = !haveDestination;
    for (const conn of discovered) {
      if (await connectionExists(this.db, p.memberId, conn.connectionRef)) continue;
      // Old-app parity: when discovery doesn't carry the account email, derive
      // it from the provider's primary calendar (its id IS the account email).
      // Best-effort — a label-less connection is still a working connection.
      let primaryEmail = conn.primaryEmail ?? null;
      if (!primaryEmail) {
        try {
          const calendars = await this.provider.listCalendars(conn.connectionRef);
          primaryEmail =
            calendars.find((c) => c.isPrimary)?.primaryEmail ??
            calendars.find((c) => c.primaryEmail)?.primaryEmail ??
            null;
        } catch {
          /* keep null */
        }
      }
      await createConnection(this.db, {
        accountId: p.accountId,
        memberId: p.memberId,
        provider: conn.provider || provider,
        externalId: conn.connectionRef,
        primaryEmail: primaryEmail ?? undefined,
        // First calendar the host connects becomes the default destination.
        isDestination: firstNew,
        checkConflicts: true,
      });
      firstNew = false;
    }
    const persisted = await listConnections(this.db, p.memberId);
    // Merge in the raw discover metadata (connectionId/connected/state/
    // updatedAt/lastActiveAt) for rows THIS call actually reported — ephemeral,
    // not persisted (our schema has no such columns). This is what lets the
    // frontend detect a completed RECONNECT of an already-linked account: a
    // reconnect reuses the same externalId/connectionRef, so "is this row new"
    // can never see it complete; "did updatedAt/lastActiveAt just advance" can.
    const byRef = new Map(discovered.map((d) => [d.connectionRef, d]));
    return persisted.map((c) => {
      const d = byRef.get(c.externalId);
      return d
        ? {
            ...c,
            connectionId: d.connectionId ?? d.connectionRef,
            connected: d.connected,
            state: d.state,
            updatedAt: d.updatedAt ?? null,
            lastActiveAt: d.lastActiveAt ?? null,
          }
        : c;
    });
  }

  /** List the calendars a connected account exposes (post-connect pick). */
  async listConnectionCalendars(p: HostPrincipal, id: string) {
    const ref = await getConnectionRef(this.db, p.memberId, id);
    if (!ref) return [];
    if (!this.provider.enabled) return [];
    return this.provider.listCalendars(ref.externalId);
  }

  /** Probe a connection's live health for the UI (never throws). */
  async pingConnection(
    p: HostPrincipal,
    id: string,
  ): Promise<{ ok: boolean; enabled: boolean; message: string }> {
    if (!this.provider.enabled) {
      return { ok: true, enabled: false, message: 'No external calendar provider configured (OSS default).' };
    }
    const ref = await getConnectionRef(this.db, p.memberId, id);
    if (!ref) return { ok: false, enabled: true, message: 'Connection not found.' };
    const health = await this.provider.checkConnection(ref.externalId);
    // Persist the outcome so the Calendars page can show health with
    // last-checked info even before the next live probe.
    await recordConnectionHealth(this.db, p.memberId, id, { ok: health.ok, detail: health.detail });
    return { ok: health.ok, enabled: true, message: health.detail };
  }

  /**
   * The "Test / Run check" self-test (the trust-building button — health
   * alone was never enough: hosts don't believe a green dot means their
   * REAL calendar is actually feeding conflict-checking). Exercises the
   * EXACT two calls the booking engine depends on: `checkConnection` (same
   * as ping) AND a real `listBusy` over the next 14 days — so a green result
   * means the pipeline demonstrably read live events, not just that the
   * token is valid. Never throws; every failure path returns a specific
   * `reason` so the UI can show what to do next (e.g. Reconnect).
   */
  async testConnection(
    p: HostPrincipal,
    id: string,
  ): Promise<{
    ok: boolean;
    healthDetail: string;
    busyCount: number | null;
    conflictCheckEnabled: boolean;
    checkedAt: number;
    reason?: 'DISCONNECTED' | 'NOT_READY' | 'READ_FAILED';
  }> {
    const checkedAt = Date.now();
    if (!this.provider.enabled) {
      return {
        ok: false,
        healthDetail: 'No external calendar provider configured (OSS default).',
        busyCount: null,
        conflictCheckEnabled: false,
        checkedAt,
        reason: 'DISCONNECTED',
      };
    }
    const row = (await listConnections(this.db, p.memberId)).find((c) => c.id === id);
    if (!row) {
      return {
        ok: false,
        healthDetail: 'Connection not found.',
        busyCount: null,
        conflictCheckEnabled: false,
        checkedAt,
        reason: 'DISCONNECTED',
      };
    }
    const health = await this.provider.checkConnection(row.externalId);
    await recordConnectionHealth(this.db, p.memberId, id, { ok: health.ok, detail: health.detail });
    if (!health.ok) {
      return {
        ok: false,
        healthDetail: health.detail,
        busyCount: null,
        conflictCheckEnabled: row.checkConflicts,
        checkedAt,
        reason: 'NOT_READY',
      };
    }
    try {
      const fromUtc = new Date(checkedAt).toISOString();
      const toUtc = new Date(checkedAt + 14 * 24 * 3600_000).toISOString();
      const busy = await this.provider.listBusy({ connectionRefs: [row.externalId], fromUtc, toUtc });
      return {
        ok: true,
        healthDetail: health.detail,
        busyCount: busy.length,
        conflictCheckEnabled: row.checkConflicts,
        checkedAt,
      };
    } catch (e) {
      return {
        ok: false,
        healthDetail: e instanceof Error ? e.message : 'Could not read events.',
        busyCount: null,
        conflictCheckEnabled: row.checkConflicts,
        checkedAt,
        reason: 'READ_FAILED',
      };
    }
  }

  // API keys.
  listApiKeys(p: HostPrincipal) {
    return listApiKeys(this.db, p.accountId);
  }
  createApiKey(p: HostPrincipal, body: { name: string; scopes: string[]; eventTypeIds?: string[]; expiresAtMs?: number }) {
    return createApiKey(this.db, { accountId: p.accountId, ...body });
  }
  revokeApiKey(p: HostPrincipal, id: string) {
    return revokeApiKey(this.db, p.accountId, id);
  }

  // Webhooks.
  listWebhooks(p: HostPrincipal) {
    return listWebhooks(this.db, p.accountId);
  }

  listWebhookDeliveries(p: HostPrincipal, webhookId: string) {
    return listWebhookDeliveries(this.db, p.accountId, webhookId);
  }
  /**
   * The encryption key, or null when this deployment has none (#75).
   *
   * Null is a legitimate READ state — a deployment that predates the envelope
   * still has plaintext secrets that must keep signing — so the signing paths
   * take `Buffer | null`. Only the WRITE path refuses (see `createWebhook`).
   */
  private webhookKeyOrNull(): Buffer | null {
    try {
      return loadEncryptionKey(this.env?.INTEGRATION_ENCRYPTION_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Create a webhook. REFUSES when there is no encryption key (#75).
   *
   * Webhooks used to work with no key at all, so this is a deliberate trim to
   * clone-and-run, made for the same reason `connectIntegration` refuses: the
   * only alternative is minting a fresh signing secret and writing it to disk in
   * the clear with nobody told. Refusing is loud, coded, and one
   * `openssl rand -base64 32` away from fixed — a silent plaintext write is none
   * of those. Webhooks that already exist are untouched and keep delivering.
   */
  createWebhook(p: HostPrincipal, body: { subscriberUrl: string; eventTriggers: string[]; secret?: string }) {
    const key = this.webhookKeyOrNull();
    if (!key) {
      throw new ServiceUnavailableException({
        error: 'INTEGRATION_KEY_MISSING',
        message:
          'This deployment cannot store a webhook signing secret: INTEGRATION_ENCRYPTION_KEY is not configured.',
      });
    }
    return createWebhook(this.db, { accountId: p.accountId, ...body, key });
  }
  deleteWebhook(p: HostPrincipal, id: string) {
    return deleteWebhook(this.db, p.accountId, id);
  }
  updateWebhook(p: HostPrincipal, id: string, patch: { active?: boolean }) {
    return updateWebhook(this.db, p.accountId, id, patch);
  }
  pingWebhook(p: HostPrincipal, id: string) {
    return pingWebhook(this.db, p.accountId, id, this.webhookKeyOrNull());
  }

  /** Resolve the account code for a principal (for host on-behalf booking). */
  async accountCode(p: HostPrincipal): Promise<string | null> {
    const me = await getMe(this.db, p.accountId, p.memberId);
    return me?.accountCode ?? null;
  }

  // --- Vanity slug (premium — included with the Dapta AI subscription) -----

  /**
   * Is this account entitled to premium features? Calendars is ALWAYS free —
   * the unlock is the customer's Dapta AI subscription, validated upstream and
   * CACHED on the account row (TTL) so nothing user-facing blocks on the
   * entitlement service. `PREMIUM_FEATURES=open` (the OSS default) short-circuits.
   */
  private async isEntitled(accountId: string): Promise<boolean> {
    if (this.premiumMode === 'open') return true;
    const acc = await this.db.get<{
      external_id: string | null;
      dapta_entitlement: string | null;
      entitlement_checked_at: number | null;
    }>(
      sql`SELECT external_id, dapta_entitlement, entitlement_checked_at
          FROM account WHERE id = ${accountId} LIMIT 1`,
    );
    if (!acc) return false;
    const checked = acc.entitlement_checked_at ? Number(acc.entitlement_checked_at) : 0;
    if (checked && Date.now() - checked < ENTITLEMENT_TTL_MS) {
      return acc.dapta_entitlement === 'paid';
    }
    if (!this.entitlements.enabled) return acc.dapta_entitlement === 'paid';
    // Refresh from the source of truth: keyed by the account owner's email
    // (the upstream service resolves customers by owner email) + org id.
    const owner = await this.db.get<{ email: string | null }>(
      sql`SELECT email FROM member
          WHERE account_id = ${accountId} AND role = 'owner' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
    );
    const paid = await this.entitlements.isPaidCustomer({
      ownerEmail: owner?.email,
      externalOrgId: acc.external_id,
    });
    await cacheEntitlement(this.db, accountId, paid ? 'paid' : 'free');
    return paid;
  }

  /** The Settings surface's view of the vanity feature. */
  async vanityStatus(
    p: HostPrincipal,
  ): Promise<{ vanitySlug: string | null; shortCode: string; canClaim: boolean }> {
    const me = await getMe(this.db, p.accountId, p.memberId);
    const entitled = await this.isEntitled(p.accountId);
    return {
      vanitySlug: me?.vanitySlug ?? null,
      shortCode: me?.accountShortCode ?? '',
      canClaim: canClaimVanitySlug(this.premiumMode, entitled),
    };
  }

  /** Claim / change / clear (null) the vanity slug. Caller enforces admin role. */
  async setVanity(
    p: HostPrincipal,
    slug: string | null,
  ): Promise<VanityOutcome | { ok: false; reason: 'NOT_ENTITLED' }> {
    const entitled = await this.isEntitled(p.accountId);
    if (!canClaimVanitySlug(this.premiumMode, entitled)) return { ok: false, reason: 'NOT_ENTITLED' };
    return setVanitySlug(this.db, p.accountId, slug);
  }

  /**
   * The authenticated host's own availability for one of their events — resolved
   * by member id, so it works before the member sets a public handle (the
   * public /v1/availability requires one). Powers /admin/bookings/new.
   */
  async myAvailability(p: HostPrincipal, q: { slug: string; from: string; to: string; timeZone?: string }) {
    const accountCode = await this.accountCode(p);
    if (!accountCode) return null;
    const fromMs = new Date(q.from).getTime();
    if (!Number.isFinite(fromMs)) return null;
    // Same 60-day window cap as the public endpoint (contract §Engine).
    const toMs = Math.min(new Date(q.to).getTime(), fromMs + 60 * 86_400_000);
    if (!Number.isFinite(toMs)) return null;
    const result = await getAvailability(
      this.db,
      { accountCode, memberId: p.memberId, slug: q.slug, fromMs, toMs, displayTimeZone: q.timeZone },
      this.calendar.provider,
    );
    if (!result) return null;
    return {
      eventType: result.eventType,
      timeZone: result.timeZone,
      slots: result.slots,
      // Config-error reason (admin surface renders the actionable copy).
      emptyReason: result.emptyReason,
    };
  }

  // --- Notification settings (Settings → Notifications; admin-gated) --------

  /**
   * The full catalog for the settings screen: every email key with its toggle,
   * custom template (or null), the shipped default in the caller's locale, and
   * the effective reminder lead times. Absent rows read as the defaults.
   */
  async listNotificationSettings(p: HostPrincipal) {
    const me = await getMe(this.db, p.accountId, p.memberId);
    const locale = me?.locale === 'es' ? 'es' : 'en';
    const stored = await getNotificationSettings(this.db, p.accountId);
    return {
      variables: [...TEMPLATE_VARIABLES],
      // Reminders and the follow-up moved to the event type (#68) — one place
      // per thing, so this screen no longer lists them. The stored rows stay as
      // the copy-forward source; they are just not editable here any more.
      settings: ACCOUNT_TEMPLATE_KEYS.map((key) => {
        const s =
          stored.get(key) ??
          { ...defaultNotificationSetting(key), enabled: defaultEnabledFor(key) };
        const def = defaultTemplate(key, locale);
        return {
          key,
          enabled: s.enabled,
          subject: s.subject,
          body: s.body,
          defaultSubject: def.subject,
          defaultBody: def.body,
          customized: s.subject != null || s.body != null,
        };
      }),
    };
  }

  updateNotificationSetting(
    p: HostPrincipal,
    key: string,
    patch: { enabled?: boolean; subject?: string | null; body?: string | null; reminderLeadMinutes?: number[] | null },
  ) {
    return upsertNotificationSetting(this.db, p.accountId, key, patch);
  }

  resetNotificationTemplate(p: HostPrincipal, key: string) {
    return resetNotificationTemplate(this.db, p.accountId, key);
  }

  /**
   * Server-side preview: render the (possibly still-unsaved) template against
   * fixed sample data — the same renderer the outbox uses, so preview ===
   * reality. Also reports tokens outside the whitelist so the editor can flag
   * them before saving.
   */
  async previewNotificationTemplate(
    p: HostPrincipal,
    key: EmailTemplateKey,
    draft: { subject?: string | null; body?: string | null },
  ) {
    const me = await getMe(this.db, p.accountId, p.memberId);
    const locale = me?.locale === 'es' ? 'es' : 'en';
    const template = resolveTemplate(key, draft, locale);
    const sample: BookingNotification & { reminderLeadMinutes?: number } = {
      accountId: p.accountId,
      uid: 'sample-uid',
      title: locale === 'es' ? 'Llamada de presentación' : 'Intro Call',
      startUtc: new Date(Date.now() + 26 * 3_600_000).toISOString(),
      endUtc: new Date(Date.now() + 26 * 3_600_000 + 30 * 60_000).toISOString(),
      host: { name: me?.displayName ?? 'Alex Rivera', email: me?.email ?? 'host@example.com' },
      attendee: {
        name: locale === 'es' ? 'Ana García' : 'Sam Guest',
        email: 'guest@example.com',
        timeZone: me?.timeZone ?? 'UTC',
      },
      location: getMessages(locale).location.conferencing,
      manageUrl: 'https://example.com/manage/sample',
      bookingLink: 'https://example.com/acme/alex-rivera/intro-call',
      cancellationReason: locale === 'es' ? 'Conflicto de agenda' : 'Schedule conflict',
      previousStartUtc: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      pending: key === 'host_booked',
      reminderLeadMinutes: 60,
    };
    const rendered = renderTemplate(template, templateVars(sample, locale));
    return {
      ...rendered,
      unknownTokens: unknownTokens(`${template.subject}\n${template.body}`),
    };
  }
}

/**
 * `IntegrationStatusRow` → what a client may see.
 *
 * The explicit field list is the point. A spread would silently start leaking
 * whatever column someone adds to the row type later, and the column this table
 * exists to hold is a decrypted-on-read credential.
 */
function toIntegrationView(row: IntegrationStatusRow): IntegrationStatusView {
  return {
    provider: row.provider,
    status: row.status,
    label: row.label,
    tokenLast4: row.tokenLast4,
    lastCheckAt: row.lastCheckAt,
    lastCheckOk: row.lastCheckOk,
    lastCheckDetail: row.lastCheckDetail,
    lastErrorDetail: row.lastErrorDetail,
  };
}
