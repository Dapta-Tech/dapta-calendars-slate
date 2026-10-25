import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Provider, { errors, interactionPolicy, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import { importJWK, jwtVerify } from 'jose';
import {
  extendOAuthRecordExpiry,
  findOAuthRecord,
  getOAuthSubject,
  listOAuthRecordsForAccount,
  liveOAuthRecordIds,
  purgeOAuthRecords,
  revokeOAuthGrant,
  takeOAuthRecord,
  upsertOAuthRecord,
  type AccountRole,
  type Db,
  type OAuthSubject,
} from '@slate/db';
import type { ServerEnv } from '@slate/config/env';
import type { HostPrincipal, MachinePrincipal } from '../auth.service';
import { RateLimitGuard, TokenBucketRateLimiter, NoopRateLimiter, type RateLimiter } from '../rate-limit';
import { DB, ENV } from '../tokens';
import { isAdmin } from '../permissions';
import { oauthAdapter, storageId } from './oauth.adapter';
import {
  BASELINE_SCOPES,
  OAUTH_MOUNT,
  cimdFetchAllowed,
  OAUTH_SCOPES,
  dcrRedirectAllowed,
  isLoopbackRedirect,
  oauthScopesFrom,
  resolveOAuthSettings,
  sameResource,
  type OAuthScope,
  type OAuthSettings,
} from './oauth.settings';

/**
 * The embedded OAuth 2.1 authorization server for the MCP endpoint.
 *
 * The protocol is oidc-provider's (PKCE, exact redirect matching, RFC 8707
 * resource indicators, RFC 9207 `iss`, CIMD, DCR, refresh rotation with reuse
 * detection, RFC 7009 revocation): nothing here re-implements an OAuth
 * primitive. What this class owns is the Calendars side:
 *
 *  - WHO SIGNS IN. There is no login form here. Every authorization request is
 *    handed to the web app's consent page, which only renders for a person the
 *    dashboard already signed in (the configured AuthProvider), and who must be
 *    an owner or admin, the same people who may mint an API key: a connection
 *    reaches the whole workspace, exactly like a key. The page posts the
 *    decision to `decide()`, which mints a single-use ticket; the browser
 *    carries it back to `finish()` on THIS origin, where the interaction cookie
 *    proves it is the same browser that started the flow. A consent link
 *    forwarded to someone else therefore cannot complete another person's
 *    request.
 *  - NO REMEMBERED CONSENT. oidc-provider's own browser session is never sent
 *    back (its cookie path is one no request uses), and the login prompt
 *    always asks, so each authorization shows the consent screen. Consent is
 *    per client and per request; the grant is what persists.
 *  - CONNECTED APPS. Each approval writes a `GrantMeta` row (what the person
 *    saw: client name and host, scopes) scoped to the account, which is what
 *    the dashboard lists and revokes.
 *  - THE MCP DOOR. `verifyAccessToken` checks our own access tokens (ES256 JWT,
 *    `iss`, `aud` = the MCP URL, `exp`) with no database read.
 */

/**
 * A person who may hold a grant: active, and owner or admin (`isAdmin`, the
 * same tier that may create an API key), because a connection acts for the
 * whole workspace exactly like a key does.
 */
export function mayHoldGrant(subject: Pick<OAuthSubject, 'role' | 'status'> | undefined): boolean {
  return !!subject && subject.status === 'active' && isAdmin(subject.role as AccountRole);
}

/** The carrier property for the client-metadata policy hook; never set by clients. */
const POLICY_PROPERTY = 'urn:dapta-calendars:client-policy';

/** Auth methods a dynamically registered client may use. */
const DCR_AUTH_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post']);

/** How long a registered client lives if nobody ever connects with it. */
const DCR_UNUSED_TTL_MS = 24 * 3_600_000;

/** How long a consent ticket lives: the browser follows it immediately. */
const TICKET_TTL_MS = 2 * 60_000;

/** At most one "last used" write per connection per this window, per replica. */
const TOUCH_EVERY_MS = 5 * 60_000;

const epochNow = (): number => Math.floor(Date.now() / 1000);

/** Text a client asserted about itself: no control characters, capped. */
function clientText(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean ? clean.slice(0, max) : null;
}

const hostOf = (uri: string): string => {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
};

const isUrlClientId = (clientId: string): boolean => clientId.startsWith('https://');

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The one page this API renders for a browser: a dead end that says what to do. */
export function oauthErrorPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

export interface ConsentDetails {
  uid: string;
  expiresAt: number;
  client: {
    id: string;
    name: string | null;
    /** The host to trust: the client_id URL's for CIMD clients, the redirect's otherwise. */
    host: string;
    via: 'cimd' | 'dcr';
    redirectUri: string;
    redirectHost: string;
    /** The code goes to a program on this computer (any app could listen there). */
    loopback: boolean;
  };
  scopes: OAuthScope[];
  /** The app will be able to stay connected (refresh) until revoked or the grant expires. */
  staysConnected: boolean;
  grantDays: number;
  account: { name: string; code: string };
  member: { email: string | null; displayName: string | null };
  canApprove: boolean;
}

export interface ConnectedApp {
  id: string;
  clientName: string | null;
  clientHost: string;
  redirectHost: string;
  via: 'cimd' | 'dcr';
  scopes: OAuthScope[];
  approvedBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

interface GrantMetaPayload {
  clientId: string;
  clientName: string | null;
  clientHost: string;
  redirectHost: string;
  via: 'cimd' | 'dcr';
  scopes: OAuthScope[];
  memberId: string;
  approvedBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

@Injectable()
export class OAuthService implements OnModuleDestroy {
  private readonly logger = new Logger('OAuth');
  readonly settings: OAuthSettings | null;
  private readonly provider: Provider | null = null;
  private readonly handler: NodeHandler | null = null;
  private verifyKey: ReturnType<typeof importJWK> | null = null;
  private readonly registerLimiter: RateLimiter;
  private readonly endpointLimiter: RateLimiter;
  private readonly cimdLimiter: RateLimiter;
  private readonly cimdGlobalLimiter: RateLimiter;
  private readonly touched = new Map<string, number>();
  private readonly purgeTimer: NodeJS.Timeout | null = null;
  /** Where audit lines go (one JSON object per line). A field so specs can read it. */
  auditSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);
  /**
   * The fetch oidc-provider uses for client metadata documents and client
   * JWKS. It receives oidc-provider's own SSRF-guarded dispatcher, timeout and
   * headers in `init`. A field so specs can serve a document without a public
   * https host; production never changes it.
   */
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
  /** The pre-fetch address check for metadata documents; a field for the same reason. */
  cimdAllowed: (clientId: string) => Promise<boolean> = (clientId) => cimdFetchAllowed(clientId);

  constructor(
    @Inject(ENV) env: ServerEnv,
    @Inject(DB) private readonly db: Db,
    @Inject(RateLimitGuard) private readonly clientKeys: RateLimitGuard,
  ) {
    this.settings = resolveOAuthSettings(env);
    // Per pod, like every limiter here. Registration is the abuse magnet (one
    // row per call), so it is the tightest; the CIMD fetch also has a global
    // bucket because each one is an outbound request this server makes.
    const on = env.RATE_LIMIT_ENABLED;
    this.registerLimiter = on ? new TokenBucketRateLimiter(10, 10 / 3600) : new NoopRateLimiter();
    this.endpointLimiter = on ? new TokenBucketRateLimiter(60, 1) : new NoopRateLimiter();
    this.cimdLimiter = on ? new TokenBucketRateLimiter(20, 0.2) : new NoopRateLimiter();
    this.cimdGlobalLimiter = on ? new TokenBucketRateLimiter(200, 5) : new NoopRateLimiter();
    if (!this.settings) return;

    const s = this.settings;
    this.provider = new Provider(s.issuer, this.configuration(s));
    // TLS ends at the load balancer; trust its X-Forwarded-Proto so cookies are
    // Secure and the URLs oidc-provider builds are https.
    this.provider.proxy = true;
    this.provider.on('server_error', (_ctx: unknown, error: Error) => this.logger.error(`oauth server_error: ${error.message}`, error.stack));
    this.provider.on('grant.revoked', (ctx: KoaContextWithOIDC, grantId: string) =>
      this.audit({ msg: 'oauth.grant_revoked', grantId, via: ctx.oidc?.route ?? 'unknown' }),
    );
    this.handler = this.provider.callback() as NodeHandler;
    this.verifyKey = importJWK(s.publicJwk, 'ES256');
    this.purgeTimer = setInterval(() => void this.purge(), 10 * 60_000);
    this.purgeTimer.unref();
    void this.purge();
    this.logger.log(
      `OAuth on: issuer ${s.issuer}, resource ${s.resource}, CIMD ${s.cimd ? 'on' : 'off'}, DCR ${s.dcr ? 'on' : 'off'}`,
    );
  }

  get enabled(): boolean {
    return this.provider !== null;
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  private configuration(s: OAuthSettings): Configuration {
    const db = this.db;
    const policy = interactionPolicy.base();
    // Every authorization goes through the Calendars consent page, even when a
    // previous approval would cover it: the check passes only on the resume of
    // an interaction that carries this request's own login result.
    policy
      .get('login')!
      .checks.add(
        new interactionPolicy.Check('calendars_consent', 'every authorization is confirmed in the Calendars dashboard', (ctx) =>
          ctx.oidc.result?.login ? interactionPolicy.Check.NO_NEED_TO_PROMPT : interactionPolicy.Check.REQUEST_PROMPT,
        ),
      );

    return {
      adapter: oauthAdapter(db, {
        refreshGraceMs: s.refreshGraceSeconds * 1000,
        dcrUnusedTtlMs: DCR_UNUSED_TTL_MS,
        onRefreshTokenStored: (grantId) => this.noteUse(grantId),
        onReuseRevoked: (kind, grantId) => this.audit({ msg: 'oauth.grant_revoked', grantId, via: `concurrent ${kind} reuse` }),
      }),
      clients: [],
      jwks: { keys: [s.signingJwk as never] },
      cookies: {
        keys: s.cookieKeys,
        names: { session: '_oauth_session', interaction: '_oauth_interaction', resume: '_oauth_resume' },
        // oidc-provider's own browser session. Scoped to a path no request
        // uses, so the browser never sends it back: nothing is remembered
        // between authorizations, and the Calendars session stays the only
        // login state.
        long: { httpOnly: true, sameSite: 'lax', signed: true, path: `${OAUTH_MOUNT}/no-session` },
        short: { httpOnly: true, sameSite: 'lax', signed: true },
      },
      routes: {
        authorization: '/authorize',
        token: '/token',
        registration: '/register',
        revocation: '/revoke',
        jwks: '/jwks',
      },
      responseTypes: ['code'],
      scopes: ['offline_access'],
      pkce: { required: () => true },
      allowOmittingSingleRegisteredRedirectUri: false,
      clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
      clientDefaults: {
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'ES256',
      },
      // Browser clients may call the token endpoint only from an origin they
      // registered as a redirect (public clients); confidential clients never.
      clientBasedCORS: (_ctx, origin, client) =>
        origin !== 'null' && client.clientAuthMethod === 'none' && (client.redirectUris ?? []).some((uri) => URL.parse(uri)?.origin === origin),
      fetch: (url, init) => this.fetchImpl(url, init),
      fetchResponseBodyLimits: { 'client_id metadata document': 5120, jwks_uri: 51_200, sector_identifier_uri: 5120 },
      features: {
        devInteractions: { enabled: false },
        rpInitiatedLogout: { enabled: false },
        userinfo: { enabled: false },
        introspection: { enabled: false },
        revocation: {
          enabled: true,
          // A client may revoke only its own tokens. A public client presenting
          // someone else's gets the normal 200 and nothing happens, so a token
          // cannot be probed for validity this way (oidc-provider's default).
          allowedPolicy: (_ctx, client, token) => {
            if (token.clientId === client.clientId) return true;
            if (client.clientAuthMethod === 'none') return false;
            throw new errors.InvalidRequest('client is not authorized to revoke the presented token');
          },
        },
        registration: { enabled: s.dcr, initialAccessToken: false, issueRegistrationAccessToken: false },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => s.resource,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, resourceIndicator) => {
            // One resource: the MCP endpoint. Anything else is refused, so a
            // token can never be minted for another audience.
            if (!sameResource(resourceIndicator, s.resource)) throw new errors.InvalidTarget();
            return {
              scope: OAUTH_SCOPES.join(' '),
              audience: s.resource,
              accessTokenTTL: s.accessTokenTtlSeconds,
              accessTokenFormat: 'jwt',
              jwt: { sign: { alg: 'ES256' } },
            };
          },
        },
        clientIdMetadataDocument: {
          enabled: s.cimd,
          ack: 'draft-02',
          // oidc-provider already allows https only, refuses special-use
          // addresses on the connected socket (DNS rebinding included), caps
          // the body and the wait, and caches a bounded number of documents.
          // This adds the rate limit (per client address, and overall) and an
          // earlier address check (see `cimdFetchAllowed`).
          allowFetch: async (ctx, clientId) => {
            const who = ctx?.req ? this.clientKeys.keyFor(ctx.req) : 'internal';
            if (!this.cimdLimiter.take(`cimd:${who}`).allowed || !this.cimdGlobalLimiter.take('cimd').allowed) return false;
            return this.cimdAllowed(clientId);
          },
        },
      },
      extraClientMetadata: {
        properties: [POLICY_PROPERTY],
        validator: (ctx, key, _value, metadata) => {
          if (key !== POLICY_PROPERTY) return;
          this.applyClientPolicy(ctx, metadata as Record<string, unknown>);
        },
      },
      interactions: {
        policy,
        url: (_ctx, interaction) => `${OAUTH_MOUNT}/interaction/${interaction.uid}`,
      },
      findAccount: async (_ctx, sub) => {
        const subject = await getOAuthSubject(db, sub);
        // A member who was disabled, removed or demoted since approving can no
        // longer refresh: the refresh grant fails with invalid_grant.
        if (!mayHoldGrant(subject)) return undefined;
        return { accountId: sub, calendarsAccountId: subject!.accountId, claims: () => ({ sub }) };
      },
      extraTokenClaims: async (ctx, token) => {
        // Only access tokens exist here (no client_credentials grant).
        const { accountId: sub, grantId } = token as { accountId?: string; grantId?: string };
        const account = ctx.oidc.entities.Account as { calendarsAccountId?: string } | undefined;
        const accountId = account?.calendarsAccountId ?? (sub ? (await getOAuthSubject(db, sub))?.accountId : undefined);
        return { account_id: accountId, grant_id: grantId };
      },
      // Every client allowed the refresh grant gets a refresh token, rotated on
      // each use; reuse of a spent one revokes the grant (see the adapter for
      // the retry grace).
      issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
      rotateRefreshToken: true,
      // Grants outlive oidc-provider's browser session (which ends with each flow).
      expiresWithSession: () => false,
      ttl: {
        AccessToken: s.accessTokenTtlSeconds,
        AuthorizationCode: 60,
        Grant: s.grantTtlSeconds,
        Interaction: 600,
        Session: 600,
        IdToken: 600,
        // Never longer than the grant: rotation hands down the remaining life,
        // so the grant TTL is an absolute limit on a connection.
        RefreshToken: (ctx) => {
          const rotated = ctx?.oidc?.entities.RotatedRefreshToken;
          if (rotated) return Math.max(1, rotated.remainingTTL);
          const grantExp = ctx?.oidc?.entities.Grant?.exp;
          return typeof grantExp === 'number' ? Math.max(1, grantExp - epochNow()) : s.grantTtlSeconds;
        },
      },
      renderError: (ctx, out) => {
        ctx.type = 'html';
        ctx.body = oauthErrorPage(
          'This sign-in could not be completed',
          `${out.error}${out.error_description ? `: ${out.error_description}` : ''}. Go back to the app you were connecting and try again.`,
        );
      },
    };
  }

  /**
   * Normalize and police client metadata. Runs for every client oidc-provider
   * builds: a dynamic registration (`ctx` present), a fetched metadata document
   * and a stored registration being loaded (no `ctx`).
   */
  private applyClientPolicy(ctx: KoaContextWithOIDC | undefined, metadata: Record<string, unknown>): void {
    delete metadata[POLICY_PROPERTY];
    const s = this.settings!;
    const redirectUris = Array.isArray(metadata.redirect_uris) ? (metadata.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string') : [];
    // Only the authorization code flow exists here; a document that also lists
    // grants this server does not offer (a device code, say) still works.
    const grants = Array.isArray(metadata.grant_types) ? (metadata.grant_types as unknown[]) : ['authorization_code'];
    metadata.grant_types = grants.filter((g) => g === 'authorization_code' || g === 'refresh_token');
    metadata.response_types = ['code'];
    // A client whose every redirect is loopback is a native app (RFC 8252),
    // whatever it declared (oidc-provider fills in `web` when nothing is):
    // OAuth 2.1 and RFC 8252 §7.3 require any port to be accepted on a
    // loopback redirect, and oidc-provider only does that for native clients.
    // That is what lets Claude Code's metadata (`http://localhost/callback`)
    // match the ephemeral port it actually listens on.
    if (redirectUris.length > 0 && redirectUris.every(isLoopbackRedirect)) metadata.application_type = 'native';
    const name = clientText(metadata.client_name, 100);
    if (name) metadata.client_name = name;
    else delete metadata.client_name;

    const clientId = typeof metadata.client_id === 'string' ? metadata.client_id : '';
    if (isUrlClientId(clientId)) {
      // A metadata document may verify its tokens with its own keys (ChatGPT
      // does), but only keys published on its own host.
      if (typeof metadata.jwks_uri === 'string' && hostOf(metadata.jwks_uri) !== hostOf(clientId))
        throw new errors.InvalidClientMetadata('jwks_uri must be on the client_id host');
    }

    if (ctx?.oidc?.route === 'registration') {
      for (const uri of redirectUris) {
        if (!dcrRedirectAllowed(uri, s.extraRedirects))
          throw new errors.InvalidRedirectUri(`redirect_uri ${uri} is not allowed for dynamically registered clients`);
      }
      const method = typeof metadata.token_endpoint_auth_method === 'string' ? metadata.token_endpoint_auth_method : 'none';
      if (!DCR_AUTH_METHODS.has(method))
        throw new errors.InvalidClientMetadata('token_endpoint_auth_method must be none, client_secret_basic or client_secret_post');
      // Nothing a registration could use to make this server fetch a URL.
      for (const prop of ['jwks', 'jwks_uri', 'sector_identifier_uri', 'request_uris', 'post_logout_redirect_uris', 'logo_uri']) {
        delete metadata[prop];
      }
    }
  }

  /** Express → oidc-provider, the official mount: strip the prefix from `req.url`. */
  async handle(req: IncomingMessage & { originalUrl?: string }, res: ServerResponse): Promise<void> {
    if (!this.handler) throw new NotFoundException();
    let original = req.originalUrl ?? req.url ?? '';
    // RFC 6749 §3.3: an authorization request that names no scope gets the
    // pre-defined default, the read-only set the resource metadata advertises.
    // Rewritten on BOTH urls: oidc-provider derives its mount path from their
    // difference, and every URL it builds (the resume step) depends on it.
    const at = new URL(original, 'http://mount.invalid');
    if (req.method === 'GET' && at.pathname === `${OAUTH_MOUNT}/authorize` && !at.searchParams.get('scope')) {
      at.searchParams.set('scope', BASELINE_SCOPES.join(' '));
      original = `${at.pathname}${at.search}`;
      req.originalUrl = original;
    }
    req.url = original.replace(OAUTH_MOUNT, '') || '/';
    // `proxy = true` is for X-Forwarded-Proto. Koa would also believe a
    // client-sent X-Forwarded-Host when building absolute URLs (the resume
    // step), and a load balancer passes that header through untouched.
    delete req.headers['x-forwarded-host'];
    await this.handler(req, res);
  }

  /** Per-address throttling for the endpoints anyone can call. */
  throttle(req: IncomingMessage, path: string): { allowed: boolean; retryAfterMs: number } {
    const who = this.clientKeys.keyFor(req);
    if (path.startsWith('/register')) return this.registerLimiter.take(`reg:${who}`);
    return this.endpointLimiter.take(`oauth:${who}`);
  }

  // --- Metadata ----------------------------------------------------------

  /** RFC 8414 authorization server metadata, built from the configured issuer (never the request's Host). */
  authorizationServerMetadata(): Record<string, unknown> {
    const s = this.settings!;
    const at = (path: string) => `${s.issuer}${OAUTH_MOUNT}${path}`;
    return {
      issuer: s.issuer,
      authorization_endpoint: at('/authorize'),
      token_endpoint: at('/token'),
      ...(s.dcr ? { registration_endpoint: at('/register') } : {}),
      revocation_endpoint: at('/revoke'),
      jwks_uri: at('/jwks'),
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'fragment', 'form_post'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES256', 'RS256', 'PS256', 'EdDSA'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
      scopes_supported: [...OAUTH_SCOPES, 'offline_access'],
      authorization_response_iss_parameter_supported: true,
      ...(s.cimd ? { client_id_metadata_document_supported: true } : {}),
    };
  }

  /** RFC 9728 protected resource metadata for the MCP endpoint. */
  protectedResourceMetadata(): Record<string, unknown> {
    const s = this.settings!;
    return {
      resource: s.resource,
      authorization_servers: [s.issuer],
      // The minimal set; writes and cancel arrive by step-up. Never offline_access.
      scopes_supported: [...BASELINE_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'dCal',
    };
  }

  /** The `WWW-Authenticate` value for a request with no (or a dead) token. */
  challenge(scopes: readonly string[], error?: 'invalid_token' | 'insufficient_scope', description?: string): string {
    const parts = [`resource_metadata="${this.settings!.resourceMetadataUrl}"`];
    if (error) parts.unshift(`error="${error}"`);
    if (description) parts.push(`error_description="${description.replace(/["\\]/g, '')}"`);
    if (scopes.length) parts.push(`scope="${scopes.join(' ')}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  // --- The MCP door ------------------------------------------------------

  /**
   * One of OUR access tokens, verified offline: ES256 signature by our key,
   * `typ` at+jwt, `iss` = our issuer, `aud` = the MCP URL, not expired. Any
   * other token (another audience, another issuer, an id token) is null.
   */
  async verifyAccessToken(token: string): Promise<MachinePrincipal | null> {
    const s = this.settings;
    if (!s || !this.verifyKey) return null;
    try {
      const { payload } = await jwtVerify(token, await this.verifyKey, {
        issuer: s.issuer,
        audience: s.resource,
        algorithms: ['ES256'],
        typ: 'at+jwt',
        clockTolerance: 5,
        requiredClaims: ['exp', 'iat', 'sub', 'client_id', 'jti'],
      });
      const accountId = payload.account_id;
      const grantId = payload.grant_id;
      const clientId = payload.client_id;
      if (typeof accountId !== 'string' || typeof grantId !== 'string' || typeof clientId !== 'string' || !payload.sub) return null;
      return {
        kind: 'oauth',
        keyId: `oauth:${grantId}`,
        prefix: `oauth:${grantId}`,
        accountId,
        memberId: payload.sub,
        clientId,
        grantId,
        scopes: oauthScopesFrom(payload.scope),
        eventTypeIds: null,
        expiresAtMs: (payload.exp ?? 0) * 1000,
      };
    } catch {
      return null;
    }
  }

  /** Record that a connection was used, at most once per window per replica. Never throws. */
  noteUse(grantId: string): void {
    const t = Date.now();
    const last = this.touched.get(grantId);
    if (last !== undefined && t - last < TOUCH_EVERY_MS) return;
    if (this.touched.size > 10_000) this.touched.clear();
    this.touched.set(grantId, t);
    void this.touchGrant(grantId, t).catch((error: unknown) => this.logger.warn(`oauth last-used update failed: ${String(error)}`));
  }

  private async touchGrant(grantId: string, at: number): Promise<void> {
    const meta = await findOAuthRecord(this.db, 'GrantMeta', grantId);
    if (!meta) return;
    await upsertOAuthRecord(this.db, {
      kind: 'GrantMeta',
      id: grantId,
      grantId,
      payload: { ...meta.payload, lastUsedAt: at },
      expiresAt: meta.expiresAt,
    });
  }

  // --- Consent -------------------------------------------------------------

  /**
   * `GET /oauth/interaction/:uid`: oidc-provider sends the browser here. The
   * interaction cookie proves this browser started the request; the person is
   * then sent to the web app, which signs them in if needed.
   */
  async startInteraction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<string> {
    const details = await this.provider!.interactionDetails(req, res);
    if (details.uid !== uid) throw new errors.SessionNotFound('interaction mismatch');
    return `${this.settings!.consentUrl}?uid=${encodeURIComponent(uid)}`;
  }

  /** What the consent page shows. 404 for an unknown, used or expired request. */
  async consentDetails(uid: string, host: HostPrincipal): Promise<ConsentDetails> {
    const interaction = await this.interaction(uid);
    const params = interaction.params as Record<string, unknown>;
    const clientId = String(params.client_id ?? '');
    const client = await this.provider!.Client.find(clientId).catch(() => undefined);
    if (!client) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This request is no longer valid.' });
    const redirectUri = String(params.redirect_uri ?? '');
    const via = isUrlClientId(clientId) ? 'cimd' : 'dcr';
    const subject = await getOAuthSubject(this.db, host.memberId);
    const asked = oauthScopesFrom(params.scope);
    return {
      uid,
      expiresAt: (interaction.exp ?? epochNow()) * 1000,
      client: {
        id: clientId,
        name: clientText(client.clientName),
        host: via === 'cimd' ? hostOf(clientId) : hostOf(redirectUri),
        via,
        redirectUri,
        redirectHost: hostOf(redirectUri),
        loopback: isLoopbackRedirect(redirectUri),
      },
      scopes: asked,
      staysConnected: client.grantTypeAllowed('refresh_token'),
      grantDays: Math.round(this.settings!.grantTtlSeconds / 86_400),
      account: { name: subject?.accountName ?? '', code: subject?.accountCode ?? '' },
      member: { email: subject?.email ?? null, displayName: subject?.displayName ?? null },
      canApprove: mayHoldGrant(subject) && subject!.accountId === host.accountId,
    };
  }

  /**
   * Record the person's decision as a single-use ticket and return where the
   * browser goes next: back to this server, where the interaction cookie must
   * match. Approval needs an owner or admin; anyone signed in may deny.
   */
  async decide(uid: string, host: HostPrincipal, decision: 'approve' | 'deny'): Promise<{ redirectTo: string }> {
    const interaction = await this.interaction(uid);
    if (decision === 'approve') {
      const subject = await getOAuthSubject(this.db, host.memberId);
      if (!mayHoldGrant(subject) || subject!.accountId !== host.accountId)
        throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Only a workspace owner or admin can connect an app.' });
    }
    const ticket = randomBytes(32).toString('base64url');
    // Never outlives its request; an interaction always carries `exp`, but a
    // missing one must not mint a ticket that is born expired.
    const until = Date.now() + TICKET_TTL_MS;
    const expiresAt = interaction.exp ? Math.min(until, interaction.exp * 1000) : until;
    await upsertOAuthRecord(this.db, {
      kind: 'ConsentTicket',
      id: storageId('ConsentTicket', ticket),
      payload: { uid, decision, memberId: host.memberId, accountId: host.accountId },
      expiresAt,
    });
    return { redirectTo: `${this.settings!.issuer}${OAUTH_MOUNT}/interaction/${encodeURIComponent(uid)}/finish?ticket=${ticket}` };
  }

  /**
   * `GET /oauth/interaction/:uid/finish?ticket=`: spend the ticket (once), in
   * the browser that started the request, and hand oidc-provider the result.
   * Returns an error message for a dead end, or null once the response is sent.
   */
  async finish(req: IncomingMessage, res: ServerResponse, uid: string, ticket: unknown): Promise<string | null> {
    const provider = this.provider!;
    let details: Awaited<ReturnType<Provider['interactionDetails']>>;
    try {
      details = await provider.interactionDetails(req, res);
    } catch {
      return 'This request expired or was opened in a different browser. Go back to the app and connect again.';
    }
    if (details.uid !== uid) return 'This request was opened in a different browser. Go back to the app and connect again.';
    if (details.result) return 'This request was already answered. Go back to the app to continue.';
    const record = typeof ticket === 'string' && ticket ? await takeOAuthRecord(this.db, 'ConsentTicket', storageId('ConsentTicket', ticket)) : undefined;
    if (!record || record.payload.uid !== uid) return 'This approval is no longer valid. Go back to the app and connect again.';
    const memberId = String(record.payload.memberId);
    const accountId = String(record.payload.accountId);
    const params = details.params as Record<string, unknown>;
    const clientId = String(params.client_id ?? '');

    const denied = async (why: string) => {
      this.audit({ msg: 'oauth.consent', decision: 'deny', accountId, clientId, reason: why });
      await provider.interactionFinished(req, res, { error: 'access_denied', error_description: why }, { mergeWithLastSubmission: false });
      return null;
    };
    if (record.payload.decision !== 'approve') return denied('The person declined the request.');
    const subject = await getOAuthSubject(this.db, memberId);
    if (!mayHoldGrant(subject) || subject!.accountId !== accountId) return denied('The approver may no longer connect apps.');

    const client = await provider.Client.find(clientId).catch(() => undefined);
    if (!client) return denied('The client is no longer valid.');
    const scopes = oauthScopesFrom(params.scope);
    const requested = new Set(typeof params.scope === 'string' ? params.scope.split(' ') : []);
    const resources = (Array.isArray(params.resource) ? params.resource : [params.resource ?? this.settings!.resource]).filter(
      (r): r is string => typeof r === 'string' && sameResource(r, this.settings!.resource),
    );

    const grant = new provider.Grant({ accountId: memberId, clientId });
    for (const resource of resources) grant.addResourceScope(resource, scopes.join(' '));
    // OIDC-level scopes the request carried must be granted too, or the
    // consent prompt would come straight back. `offline_access` is the one MCP
    // clients send; it changes nothing (refresh follows the client's grant types).
    const oidcScopes = ['openid', 'offline_access'].filter((x) => requested.has(x));
    if (oidcScopes.length) grant.addOIDCScope(oidcScopes.join(' '));
    const grantId = await grant.save();
    const expiresAt = (grant.exp ?? epochNow() + this.settings!.grantTtlSeconds) * 1000;
    const redirectUri = String(params.redirect_uri ?? '');
    const via = isUrlClientId(clientId) ? 'cimd' : 'dcr';
    const meta: GrantMetaPayload = {
      clientId,
      clientName: clientText(client.clientName),
      clientHost: via === 'cimd' ? hostOf(clientId) : hostOf(redirectUri),
      redirectHost: hostOf(redirectUri),
      via,
      scopes,
      memberId,
      approvedBy: subject!.email,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    try {
      await upsertOAuthRecord(this.db, { kind: 'GrantMeta', id: grantId, grantId, accountId, payload: { ...meta }, expiresAt });
      // A registration someone connected with lives as long as its grant.
      // (Metadata-document clients are never stored: oidc-provider resolves
      // them from the document, cached, on every use.)
      if (via === 'dcr') await extendOAuthRecordExpiry(this.db, 'Client', clientId, expiresAt);
    } catch (error) {
      // Never leave a grant nobody can see or disconnect, and still answer
      // the client so it is not left waiting for a redirect.
      await revokeOAuthGrant(this.db, grantId).catch(() => undefined);
      this.logger.error(`oauth consent could not be recorded: ${String(error)}`);
      await provider.interactionFinished(
        req,
        res,
        { error: 'server_error', error_description: 'The connection could not be recorded. Try again.' },
        { mergeWithLastSubmission: false },
      );
      return null;
    }
    this.audit({ msg: 'oauth.consent', decision: 'approve', accountId, clientId, grantId, scopes });
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId: memberId, remember: false }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
    return null;
  }

  private async interaction(uid: string) {
    const interaction = typeof uid === 'string' && uid ? await this.provider?.Interaction.find(uid) : undefined;
    if (!interaction || interaction.result) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This request is no longer valid.' });
    return interaction;
  }

  // --- Connected apps ------------------------------------------------------

  /** The account's live connections, newest first. Account-scoped (invariant 4). */
  async listGrants(accountId: string): Promise<ConnectedApp[]> {
    const metas = await listOAuthRecordsForAccount(this.db, accountId, 'GrantMeta');
    const live = await liveOAuthRecordIds(this.db, 'Grant', metas.map((m) => m.id));
    return metas
      .filter((m) => live.has(m.id))
      .map((m) => {
        const p = m.payload as unknown as GrantMetaPayload;
        return {
          id: m.id,
          clientName: p.clientName ?? null,
          clientHost: p.clientHost,
          redirectHost: p.redirectHost,
          via: p.via,
          scopes: oauthScopesFrom((p.scopes ?? []).join(' ')),
          approvedBy: p.approvedBy ?? null,
          createdAt: p.createdAt,
          lastUsedAt: p.lastUsedAt ?? null,
          expiresAt: m.expiresAt,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Revoke one of the account's connections: its refresh tokens die now, its
   * outstanding access tokens at their expiry. False when the id is not this
   * account's (indistinguishable from absent).
   */
  async revokeGrant(accountId: string, grantId: string, by: string): Promise<boolean> {
    const meta = await findOAuthRecord(this.db, 'GrantMeta', grantId);
    if (!meta || meta.accountId !== accountId) return false;
    await revokeOAuthGrant(this.db, grantId);
    this.audit({ msg: 'oauth.grant_revoked', grantId, accountId, via: 'dashboard', by });
    return true;
  }

  private async purge(): Promise<void> {
    try {
      await purgeOAuthRecords(this.db);
    } catch (error) {
      this.logger.warn(`oauth purge failed: ${String(error)}`);
    }
  }

  private audit(fields: Record<string, unknown>): void {
    try {
      this.auditSink(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ...fields }));
    } catch {
      /* logging must never break a flow */
    }
  }
}
