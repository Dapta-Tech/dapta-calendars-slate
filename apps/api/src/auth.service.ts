import { ForbiddenException, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  acceptInvitedMember,
  findMembership,
  getPersonIdentity,
  listWorkspacesForIdentity,
  verifyApiKey,
  memberRoleAndLoginSeen,
  noteMemberLogin,
} from '@slate/db';
import type { ServerEnv } from '@slate/config/env';
import { WORKSPACE_HEADER, type ApiScope, type WorkspaceView } from '@slate/types';
import { AUTH_PROVIDER, DB, ENV } from './tokens';
import { header, type AuthProvider, type HostPrincipal, type ReqLike, type ResolvedHost } from './auth.provider';
import { annotateRequestAccount } from './request-log';
import { AnalyticsEffects } from './analytics-effects';

export type { HostPrincipal, ReqLike } from './auth.provider';

/** How stale `member.login_seen_at` may get before a verified login stamps it again, at most. */
export const LOGIN_SEEN_REFRESH_MS = 86_400_000;

/**
 * The refresh step for a link window of `maxAgeDays`: a day, or a quarter of
 * the window when that is shorter. A whole day against a one-day window would
 * let a person who signs in every 23 hours fall out of it between stamps.
 */
export function loginSeenRefreshMs(maxAgeDays: number): number {
  return Math.min(LOGIN_SEEN_REFRESH_MS, (maxAgeDays * 86_400_000) / 4);
}

export interface MachinePrincipal {
  /**
   * For an OAuth connection, `oauth:<grantId>`; for a sign-in through an
   * external authorization server, `login:<memberId>`: the idempotency and
   * rate-limit namespace.
   */
  keyId: string;
  /** The key's public `dcl_<8hex>` handle (`oauth:<grantId>` for OAuth, `login:<8 chars>` for a sign-in); safe to log. */
  prefix: string;
  accountId: string;
  scopes: string[];
  eventTypeIds: string[] | null;
  /** Epoch ms, or null when the key never expires (an OAuth token always expires). */
  expiresAtMs: number | null;
  /** How the caller authenticated. Absent means an API key (every pre-OAuth call site). */
  kind?: 'api_key' | 'oauth';
  /** OAuth only: the member who approved the connection (the token's `sub`), or the member a sign-in acts as. */
  memberId?: string;
  /** OAuth only: the client the token was issued to (a URL for CIMD clients). */
  clientId?: string;
  /** OAuth only: the connection (grant) the token belongs to. Absent on a sign-in through an external server. */
  grantId?: string;
  /** External sign-in only: the authorization server's session (`sid`), when the token carries one. Logged, never trusted. */
  sessionId?: string;
}

/**
 * Auth authority for the API. Host/dashboard identity is delegated to the
 * pluggable `AuthProvider` port (local dev stub / WorkOS overlay) selected on
 * `AUTH_PROVIDER`; machine identity is a hashed API key resolved here (that path
 * is production-grade in OSS too).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  private readonly loginSeenRefreshMs: number;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    // Optional so specs can build the service with two arguments: the default window.
    @Optional() @Inject(ENV) env?: Pick<ServerEnv, 'OAUTH_LINK_MAX_AGE_DAYS'>,
    // Product analytics, for the one event this layer sees (an invitation
    // accepted). LAST and @Optional(): absent, nothing is reported.
    @Optional() @Inject(AnalyticsEffects) private readonly analytics?: AnalyticsEffects,
  ) {
    this.loginSeenRefreshMs = loginSeenRefreshMs(env?.OAUTH_LINK_MAX_AGE_DAYS ?? 30);
  }

  /**
   * Resolve the authenticated host via the configured provider, then enrich it
   * with the account role (`member.role`) so the permission layer can authorize.
   * The provider stays role-agnostic; role resolution is centralized here so it
   * behaves identically across the local and workos providers. Throws 401 if the
   * provider cannot resolve the host.
   *
   * The same read tells when the upstream identity service last vouched for
   * this member (`login_seen_at`, what an MCP sign-in through an external
   * authorization server is held to). It is stamped with the token's issue
   * time, never the request time: a token minted before someone was removed
   * upstream stays valid until it expires, and using it must not keep the
   * stamp fresh. A stamp older than that by the refresh step (a day, or a
   * quarter of a shorter link window) is renewed here, for every provider,
   * and never moves backwards; a token that does not say when it was issued
   * stamps nothing. A failed write is logged and never costs the request.
   */
  async resolveHost(req: ReqLike): Promise<HostPrincipal> {
    const id = await this.actingAs(req, await this.provider.resolveHost(req));
    annotateRequestAccount(req, id.accountId);
    const member = await memberRoleAndLoginSeen(this.db, id.accountId, id.memberId);
    const vouchedAt = id.authenticatedAt === null ? null : Math.min(id.authenticatedAt ?? Date.now(), Date.now());
    const step = this.loginSeenRefreshMs;
    if (member && vouchedAt !== null && (member.loginSeenAt === null || vouchedAt - member.loginSeenAt >= step)) {
      await noteMemberLogin(this.db, id.accountId, id.memberId, vouchedAt, step).catch((error: unknown) =>
        this.logger.warn(`could not stamp the login of member ${id.memberId}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return { ...id, role: member?.role ?? 'member' };
  }

  /**
   * WHO is calling and WHERE they act are two questions. The provider answers
   * the first from the token it validated; the account it resolves is the
   * person's home. A request may NAME another account in `x-dcal-workspace`,
   * and that name is only a request: membership is re-derived from the
   * database, on every request, from the identity the provider proved (subject,
   * or the address of a not-yet-bound invitation). A name the person holds no
   * membership in is a 403, never a quiet fall back to the home account, which
   * would land writes in a tenant the person did not believe they were in.
   *
   * No header, or the home account named: exactly the provider's answer, as
   * before this existed. Either way, the first request an invited member makes
   * in an account accepts the invitation (`acceptInvitedMember`).
   */
  private async actingAs(req: ReqLike, home: ResolvedHost): Promise<ResolvedHost> {
    const requested = header(req, WORKSPACE_HEADER)?.trim();
    if (!requested || requested === home.accountId) {
      await this.acceptIfInvited(home.accountId, home.memberId);
      return home;
    }
    const identity = await getPersonIdentity(this.db, home.accountId, home.memberId);
    const membership = identity ? await findMembership(this.db, identity, requested) : null;
    if (!membership) {
      throw new ForbiddenException({ error: 'WORKSPACE_FORBIDDEN', message: 'You are not a member of that workspace.' });
    }
    if (membership.status === 'invited') {
      await this.acceptIfInvited(membership.accountId, membership.memberId, identity?.externalId ?? null);
    }
    return { ...home, accountId: membership.accountId, memberId: membership.memberId };
  }

  /** Turn an invitation active on first use, and report it once. Never costs the request. */
  private async acceptIfInvited(accountId: string, memberId: string, externalId: string | null = null): Promise<void> {
    try {
      if (!(await acceptInvitedMember(this.db, accountId, memberId, externalId))) return;
      const role = (await memberRoleAndLoginSeen(this.db, accountId, memberId))?.role ?? 'member';
      void this.analytics?.hostEvent('invite_accepted', { accountId, memberId }, { role });
    } catch (error) {
      this.logger.warn(`could not accept the invitation of member ${memberId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Every workspace the caller can act in, from their HOME identity (never from
   * the one they are viewing, so the list reads the same from anywhere), with
   * the one this request acts in marked.
   */
  async listWorkspaces(req: ReqLike): Promise<WorkspaceView[]> {
    const home = await this.provider.resolveHost(req);
    const acting = await this.actingAs(req, home);
    const identity = await getPersonIdentity(this.db, home.accountId, home.memberId);
    const rows = identity ? await listWorkspacesForIdentity(this.db, identity) : [];
    return rows.map((w) => ({
      accountId: w.accountId,
      accountCode: w.accountCode,
      accountName: w.accountName,
      role: w.role,
      status: w.status,
      current: w.accountId === acting.accountId,
      home: w.accountId === home.accountId,
    }));
  }

  /**
   * Verify one presented API key and return its principal, or null when it is
   * unknown, revoked or expired. No scope check: the MCP door authenticates once
   * per request and then checks scopes per tool.
   */
  async authenticateKey(key: string): Promise<MachinePrincipal | null> {
    return key ? verifyApiKey(this.db, key) : null;
  }

  /**
   * Resolve a machine principal from an API key and enforce a required scope.
   * A list means "any of": the REST cancel routes take `bookings:cancel` or the
   * older `bookings:write`, so keys minted before the cancel scope existed keep
   * working.
   */
  async resolveMachine(
    req: ReqLike,
    requiredScope: ApiScope | readonly ApiScope[],
  ): Promise<MachinePrincipal> {
    const auth = header(req, 'authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const key = bearer ?? header(req, 'x-api-key');
    const principal = key ? await verifyApiKey(this.db, key) : null;
    if (!principal)
      throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'Invalid API key.' });
    annotateRequestAccount(req, principal.accountId);
    const accepted = Array.isArray(requiredScope) ? requiredScope : [requiredScope as ApiScope];
    if (!accepted.some((scope) => principal.scopes.includes(scope)))
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `Missing scope: ${accepted.join(' or ')}` });
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
