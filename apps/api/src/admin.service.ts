import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  checkHandleAvailable,
  confirmBooking,
  createApiKey,
  createBooking,
  createConnection,
  declineBooking,
  createWebhook,
  deleteConnection,
  deleteWebhook,
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
import { DB } from './tokens';

/** Authed host/dashboard operations. All are scoped to the caller's account. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
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
    if (out.ok) this.calendar.onBookingCancelled(uid);
    return out;
  }

  async confirm(p: HostPrincipal, uid: string) {
    const out = await confirmBooking(this.db, uid, p.accountId);
    // pending→accepted: NOW write the event to the host's calendar.
    if (out.ok) this.calendar.onBookingAccepted(uid);
    return out;
  }

  decline(p: HostPrincipal, uid: string, reason?: string) {
    return declineBooking(this.db, uid, reason, p.accountId);
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

  /** Resolve the account code for a principal (for host on-behalf booking). */
  async accountCode(p: HostPrincipal): Promise<string | null> {
    const me = await getMe(this.db, p.accountId, p.memberId);
    return me?.accountCode ?? null;
  }
}
