import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Db } from '@slate/db';
import { verifyApiKey } from '@slate/db';
import type { ApiScope } from '@slate/types';
import { AUTH_PROVIDER, DB } from './tokens';
import { header, type AuthProvider, type HostPrincipal, type ReqLike } from './auth.provider';

export type { HostPrincipal, ReqLike } from './auth.provider';

export interface MachinePrincipal {
  accountId: string;
  scopes: string[];
  eventTypeIds: string[] | null;
}

/**
 * Auth authority for the API. Host/dashboard identity is delegated to the
 * pluggable `AuthProvider` port (local dev stub / WorkOS overlay) selected on
 * `AUTH_PROVIDER`; machine identity is a hashed API key resolved here (that path
 * is production-grade in OSS too).
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {}

  /** Resolve the authenticated host via the configured provider. Throws 401. */
  resolveHost(req: ReqLike): Promise<HostPrincipal> {
    return this.provider.resolveHost(req);
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
