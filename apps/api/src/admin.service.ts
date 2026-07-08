import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  checkHandleAvailable,
  createApiKey,
  createBooking,
  createConnection,
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
  cancelBooking,
} from '@slate/db';
import type { HostPrincipal } from './auth.service';
import { DB } from './tokens';

/** Authed host/dashboard operations. All are scoped to the caller's account. */
@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db) {}

  me(p: HostPrincipal) {
    return getMe(this.db, p.accountId, p.memberId);
  }

  handleAvailable(p: HostPrincipal, handle: string) {
    return checkHandleAvailable(this.db, p.accountId, handle, p.memberId);
  }

  updateBranding(p: HostPrincipal, patch: Parameters<typeof updateBranding>[2]) {
    return updateBranding(this.db, p.memberId, patch);
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

  hostCreate(
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
    return createBooking(this.db, {
      accountCode,
      handle: body.handle,
      slug: body.slug,
      startMs: new Date(body.startUtc).getTime(),
      attendee: body.attendee,
      answers: body.answers,
      onBehalf: true,
    });
  }

  hostCancel(_p: HostPrincipal, uid: string, reason?: string) {
    return cancelBooking(this.db, { uid, reason, byHost: true });
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
