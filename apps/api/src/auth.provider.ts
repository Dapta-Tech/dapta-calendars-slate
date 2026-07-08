/**
 * The host AuthProvider seam. Host/dashboard identity is resolved through a
 * pluggable `AuthProvider` port selected by `AUTH_PROVIDER` (config/env), so the
 * enum is genuinely load-bearing:
 *
 *   - `local`  — the OSS dev stub (this file). Resolves the seeded account+member
 *                and NEVER trusts client identity in production.
 *   - `workos` — a validated-JWT adapter that ships in the private overlay, wired
 *                by `createAuthProvider`. Selecting it in the pure OSS build fails
 *                loud rather than silently serving the stub.
 *
 * Machine identity is a separate, production-grade path (a hashed API key) and
 * lives on `AuthService`.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Db } from '@slate/db';
import { sql } from '@slate/db';
import type { ServerEnv } from '@slate/config/env';

export interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}

export interface HostPrincipal {
  accountId: string;
  memberId: string;
}

export function header(req: ReqLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The port every host-auth backend implements. */
export interface AuthProvider {
  readonly name: string;
  /** Resolve the authenticated host (dashboard). Throws 401 if unresolved. */
  resolveHost(req: ReqLike): Promise<HostPrincipal>;
}

/**
 * OSS dev stub. It resolves the FIRST seeded account+member and does NOT trust
 * arbitrary client identity: the `x-slate-account` / `x-slate-member`
 * impersonation headers are a development-only convenience for exercising
 * multi-account flows without an auth server, and are IGNORED unless
 * `NODE_ENV` is development/test. `loadServerEnv` additionally refuses to boot
 * this provider in production, so it is doubly impossible to spoof in prod.
 */
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';

  constructor(
    private readonly db: Db,
    private readonly env: Pick<ServerEnv, 'NODE_ENV'>,
  ) {}

  async resolveHost(req: ReqLike): Promise<HostPrincipal> {
    if (this.env.NODE_ENV !== 'production') {
      const accountId = header(req, 'x-slate-account');
      const memberId = header(req, 'x-slate-member');
      if (accountId && memberId) return { accountId, memberId };
    }

    // Dev fallback: the first account + its first member (single-tenant stub).
    const row = await this.db.get<{ account_id: string; member_id: string }>(
      sql`SELECT a.id AS account_id, m.id AS member_id
          FROM account a JOIN member m ON m.account_id = a.id
          ORDER BY a.created_at ASC, m.created_at ASC LIMIT 1`,
    );
    if (!row) throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'No session.' });
    return { accountId: row.account_id, memberId: row.member_id };
  }
}

/**
 * Select the host AuthProvider for the configured `AUTH_PROVIDER`. This is the
 * DI seam `app.module` uses. `workos` throws unless the private overlay has
 * replaced this factory with one that returns a concrete WorkOS adapter — never
 * a silent fallback to the insecure stub.
 */
export function createAuthProvider(env: ServerEnv, db: Db): AuthProvider {
  switch (env.AUTH_PROVIDER) {
    case 'local':
      return new LocalAuthProvider(db, env);
    case 'workos':
      throw new Error(
        'AUTH_PROVIDER=workos requires the private WorkOS AuthKit adapter overlay, which is not bundled in ' +
          'the open-source build. Provide a concrete AuthProvider (see docs/auth) or use AUTH_PROVIDER=local ' +
          'for development only.',
      );
    default:
      throw new Error(`Unknown AUTH_PROVIDER: ${String((env as ServerEnv).AUTH_PROVIDER)}`);
  }
}
