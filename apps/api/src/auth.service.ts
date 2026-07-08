import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Db } from '@slate/db';
import { verifyApiKey, sql } from '@slate/db';
import type { ApiScope } from '@slate/types';
import { DB } from './tokens';

export interface HostPrincipal {
  accountId: string;
  memberId: string;
}

export interface MachinePrincipal {
  accountId: string;
  scopes: string[];
  eventTypeIds: string[] | null;
}

export interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}

function header(req: ReqLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The AuthProvider seam. The OSS default is a LOCAL dev stub: host identity is
 * read from `x-slate-account` / `x-slate-member` headers, falling back to the
 * single seeded account+member so a fork can call authed endpoints with no auth
 * server. A private overlay swaps this for WorkOS AuthKit (validated JWT).
 * Machine identity is always a real API key (hashed lookup) — that path is
 * production-grade in OSS too.
 */
@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Resolve the authenticated host (dashboard). Throws 401 if unresolved. */
  async resolveHost(req: ReqLike): Promise<HostPrincipal> {
    const accountId = header(req, 'x-slate-account');
    const memberId = header(req, 'x-slate-member');
    if (accountId && memberId) return { accountId, memberId };

    // Dev fallback: the first account + its first member (local stub only).
    const row = await this.db.get<{ account_id: string; member_id: string }>(
      sql`SELECT a.id AS account_id, m.id AS member_id
          FROM account a JOIN member m ON m.account_id = a.id
          ORDER BY a.created_at ASC, m.created_at ASC LIMIT 1`,
    );
    if (!row) throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'No session.' });
    return { accountId: row.account_id, memberId: row.member_id };
  }

  /** Resolve a machine principal from an API key and enforce a required scope. */
  async resolveMachine(req: ReqLike, requiredScope: ApiScope): Promise<MachinePrincipal> {
    const auth = header(req, 'authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const key = bearer ?? header(req, 'x-api-key');
    const principal = key ? await verifyApiKey(this.db, key) : null;
    if (!principal)
      throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'Invalid API key.' });
    if (!principal.scopes.includes(requiredScope))
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `Missing scope: ${requiredScope}` });
    return principal;
  }

  /**
   * Enforce the machine resource allowlist (anti-uid-probing): if the key is
   * scoped to specific event types, an out-of-scope target is indistinguishable
   * from not-found — both surface as 403, never revealing existence.
   */
  assertEventTypeAllowed(principal: MachinePrincipal, eventTypeId: string | null): void {
    if (principal.eventTypeIds && (!eventTypeId || !principal.eventTypeIds.includes(eventTypeId)))
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Not permitted for this resource.' });
  }
}
