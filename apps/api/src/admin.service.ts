import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  checkHandleAvailable,
  confirmBooking,
  createApiKey,
  createBooking,
  createConnection,
  updateConnection,
  connectionExists,
  getConnectionRef,
  declineBooking,
  createWebhook,
  updateWebhook,
  pingWebhook,
  deleteConnection,
  deleteWebhook,
  enqueueWebhookDeliveries,
  getMe,
  listApiKeys,
  listBookings,
  listConnections,
  listWebhooks,
  revokeApiKey,
  updateBranding,
  updateHandle,
  updateMemberSettings,
  cancelBooking,
} from '@slate/db';
import type { HostPrincipal } from './auth.service';
import { CalendarEffects } from './calendar-effects';
import { asConnector } from './calendar.http-provider';
import { EmailEffects } from './email-effects';
import { DB } from './tokens';

/** Authed host/dashboard operations. All are scoped to the caller's account. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
    @Inject(EmailEffects) private readonly email: EmailEffects,
  ) {}

  me(p: HostPrincipal) {
    return getMe(this.db, p.accountId, p.memberId);
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
      handle: string;
      slug: string;
      startUtc: string;
      attendee: { name: string; email: string; timeZone: string; notes?: string; phone?: string };
      answers?: Record<string, unknown>;
    },
    accountCode: string,
  ) {
    const outcome = await createBooking(this.db, {
      accountCode,
      handle: body.handle,
      slug: body.slug,
      startMs: new Date(body.startUtc).getTime(),
      attendee: body.attendee,
      answers: body.answers,
      onBehalf: true,
    });
    // Write out only a fresh ACCEPTED booking (pending waits for confirm).
    if (outcome.ok && outcome.booking.status === 'accepted')
      this.calendar.onBookingAccepted(outcome.booking.uid);
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
      void this.email.enqueueCancellation(uid, { reason: reason ?? null });
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
      void this.email.enqueueConfirmation(uid);
      // Now that it's confirmed, schedule its pre-meeting reminders.
      void this.email.enqueueReminders(uid);
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
      void enqueueWebhookDeliveries(this.db, p.accountId, 'booking.cancelled', {
        uid,
        reason: reason ?? null,
      }).catch(() => undefined);
    }
    return out;
  }

  // Connections (behind the CalendarProvider port — generic).
  listConnections(p: HostPrincipal) {
    return listConnections(this.db, p.memberId);
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
   */
  async connectionToken(
    p: HostPrincipal,
    provider: string,
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
    const start = await connector.startConnect(provider, p.memberId);
    return { enabled: true, token: start.token, connectUrl: start.connectUrl, message: 'Connect started.' };
  }

  /**
   * After the OAuth popup completes, discover the tenant's connection(s) for the
   * provider and persist any not already stored (first destination wins R20).
   * Returns the connections now on record.
   */
  async discoverConnections(p: HostPrincipal, provider: string) {
    const connector = asConnector(this.provider);
    if (!connector) return listConnections(this.db, p.memberId);
    const discovered = await connector.discoverConnections(p.memberId, provider);
    const haveDestination = (await listConnections(this.db, p.memberId)).some((c) => c.isDestination);
    let firstNew = !haveDestination;
    for (const conn of discovered) {
      if (await connectionExists(this.db, p.memberId, conn.connectionRef)) continue;
      await createConnection(this.db, {
        accountId: p.accountId,
        memberId: p.memberId,
        provider: conn.provider || provider,
        externalId: conn.connectionRef,
        primaryEmail: conn.primaryEmail ?? undefined,
        // First calendar the host connects becomes the default destination.
        isDestination: firstNew,
        checkConflicts: true,
      });
      firstNew = false;
    }
    return listConnections(this.db, p.memberId);
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
    return { ok: health.ok, enabled: true, message: health.detail };
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
  createWebhook(p: HostPrincipal, body: { subscriberUrl: string; eventTriggers: string[]; secret?: string }) {
    return createWebhook(this.db, { accountId: p.accountId, ...body });
  }
  deleteWebhook(p: HostPrincipal, id: string) {
    return deleteWebhook(this.db, p.accountId, id);
  }
  updateWebhook(p: HostPrincipal, id: string, patch: { active?: boolean }) {
    return updateWebhook(this.db, p.accountId, id, patch);
  }
  pingWebhook(p: HostPrincipal, id: string) {
    return pingWebhook(this.db, p.accountId, id);
  }

  /** Resolve the account code for a principal (for host on-behalf booking). */
  async accountCode(p: HostPrincipal): Promise<string | null> {
    const me = await getMe(this.db, p.accountId, p.memberId);
    return me?.accountCode ?? null;
  }
}
