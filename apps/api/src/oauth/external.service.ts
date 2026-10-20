import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { membershipsBySubject, type AccountRole, type Db } from '@slate/db';
import { oauthMode, type ServerEnv } from '@slate/config/env';
import { isAdmin } from '../permissions';
import { DB, ENV } from '../tokens';
import { resourceMetadataUrlFor, trimSlash } from './oauth.settings';

/**
 * The MCP endpoint as an OAuth resource server for an EXTERNAL authorization
 * server (OAUTH_AUTHORIZATION_SERVER). Sign-in, consent, client registration
 * and tokens all belong to that server; this class only:
 *
 *  - PUBLISHES where to sign in: the protected-resource metadata (RFC 9728)
 *    naming the external server, and, for clients that still read it from the
 *    resource's origin, that server's own metadata, fetched here and cached.
 *  - VERIFIES its access tokens at the MCP door against its JWKS: RS256 or
 *    ES256 only, `iss` exactly the configured issuer, `aud` containing the MCP
 *    URL (RFC 8707), `sub` and `exp` present. Nothing else in the token is
 *    trusted; `client_id`/`azp` and `sid` are only logged.
 *  - MAPS the token's `sub` to the members it may act as: the person whose
 *    `idp_subject` the host login provider recorded, in every account they
 *    belong to, among members whose web login was verified within
 *    OAUTH_LINK_MAX_AGE_DAYS, active owners and admins only (`mayAct`, the
 *    tier that may create an API key), read on every request.
 *
 * Every outbound request is to a configured URL (never one built from a
 * request header), carries no header of the caller's, and is bounded in time,
 * size and redirects. Any failure, an outage included, verifies nothing.
 */

/** Time and size caps for every request this class makes. */
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
/** How long a fetched metadata document is served before it is fetched again. */
const METADATA_TTL_MS = 60 * 60_000;
/** After a failed fetch, how long the last good document (or the failure) stands. */
const METADATA_RETRY_MS = 30_000;
/** Seconds of clock skew allowed on `exp` and `nbf`. */
const CLOCK_TOLERANCE_S = 30;
/** What `resource_name` says in the protected-resource metadata. */
const RESOURCE_NAME = 'Dapta Calendars';

export interface ExternalOAuthSettings {
  /** The external server's issuer, exactly as configured (and as its metadata and tokens write it). */
  issuer: string;
  /** The MCP endpoint URL: the audience its tokens must carry. */
  resource: string;
  /** Where the protected-resource metadata for `resource` lives (RFC 9728). */
  resourceMetadataUrl: string;
  /** OAUTH_JWKS_URL, or null to use the metadata's `jwks_uri`. */
  jwksUrl: string | null;
  /** http is accepted for a fetched `jwks_uri` only on loopback outside production. */
  production: boolean;
  /** How long after its last verified web login a member stays reachable (OAUTH_LINK_MAX_AGE_DAYS). */
  linkMaxAgeMs: number;
}

/** The settings, or null unless OAuth is on with an external authorization server. */
export function resolveExternalSettings(env: ServerEnv): ExternalOAuthSettings | null {
  if (oauthMode(env) !== 'external' || !env.MCP_PUBLIC_URL || !env.OAUTH_AUTHORIZATION_SERVER) return null;
  const resource = trimSlash(new URL(env.MCP_PUBLIC_URL).href);
  return {
    issuer: env.OAUTH_AUTHORIZATION_SERVER,
    resource,
    resourceMetadataUrl: resourceMetadataUrlFor(resource),
    jwksUrl: env.OAUTH_JWKS_URL ?? null,
    production: env.NODE_ENV === 'production',
    linkMaxAgeMs: env.OAUTH_LINK_MAX_AGE_DAYS * 86_400_000,
  };
}

/** What a verified access token says about who is calling. */
export interface ExternalLogin {
  /** The person at the external server (`sub`). */
  subject: string;
  expiresAtMs: number;
  /** `client_id`, else `azp`, when present: for the audit line only. */
  clientId?: string;
  /** `sid` when present: for the audit line only. */
  sessionId?: string;
}

/** An account a sign-in may act in, as the member it acts as there. */
export interface LoginAccount {
  accountId: string;
  accountName: string;
  memberId: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or http on a loopback host outside production. */
function fetchableUrl(value: unknown, production: boolean): string | null {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || url.username || url.password) return null;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && !production && LOOPBACK.has(url.hostname))) return url.href;
  return null;
}

/** Printable and short, for a value that only ever reaches a log line. */
function logValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 200) || undefined;
}

/**
 * A member a sign-in may act as: active, and owner or admin (`isAdmin`, the
 * same tier that may create an API key), because a sign-in acts for the whole
 * account exactly like a key does.
 */
function mayAct(member: { role: string; status: string }): boolean {
  return member.status === 'active' && isAdmin(member.role as AccountRole);
}

@Injectable()
export class ExternalOAuthService {
  private readonly logger = new Logger('OAuth');
  readonly settings: ExternalOAuthSettings | null;
  private metadataCache: { doc: Record<string, unknown>; at: number } | null = null;
  private metadataFailedAt = 0;
  private metadataInFlight: Promise<Record<string, unknown>> | null = null;
  private jwks: { url: string; get: JWTVerifyGetKey } | null = null;
  /**
   * Every outbound request goes through here. A field so specs can serve the
   * metadata and keys from a local server; production never changes it.
   */
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
  /** The time limit on each of those requests; a field so specs can shorten it. */
  fetchTimeoutMs = FETCH_TIMEOUT_MS;

  constructor(
    @Inject(ENV) env: ServerEnv,
    @Inject(DB) private readonly db: Db,
  ) {
    this.settings = resolveExternalSettings(env);
    if (this.settings)
      this.logger.log(`OAuth on: external authorization server ${this.settings.issuer}, resource ${this.settings.resource}`);
  }

  get enabled(): boolean {
    return this.settings !== null;
  }

  // --- Discovery -----------------------------------------------------------

  /** RFC 9728 protected resource metadata, from configuration only (never the request's Host). */
  protectedResourceMetadata(): Record<string, unknown> {
    const s = this.settings!;
    return {
      resource: s.resource,
      authorization_servers: [s.issuer],
      bearer_methods_supported: ['header'],
      // The external server's own scopes say nothing about what a tool may do here.
      scopes_supported: [],
      resource_name: RESOURCE_NAME,
    };
  }

  /** The `WWW-Authenticate` value for a request with no (or a dead) token. Never a `scope`. */
  challenge(error?: 'invalid_token', description?: string): string {
    const parts = [`resource_metadata="${this.settings!.resourceMetadataUrl}"`];
    if (error) parts.unshift(`error="${error}"`);
    if (description) parts.push(`error_description="${description.replace(/["\\]/g, '')}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  /**
   * The external server's RFC 8414 metadata: fetched, checked (its `issuer`
   * must be exactly the configured one), cached for an hour. While a refresh
   * fails the last good document keeps being served; with none, it throws, and
   * nothing is fetched again for a short while.
   */
  async authorizationServerMetadata(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.metadataCache && now - this.metadataCache.at < METADATA_TTL_MS) return this.metadataCache.doc;
    if (now - this.metadataFailedAt < METADATA_RETRY_MS) {
      if (this.metadataCache) return this.metadataCache.doc;
      throw new Error('authorization server metadata unavailable');
    }
    this.metadataInFlight ??= this.fetchMetadata()
      .then(
        (doc) => {
          this.metadataCache = { doc, at: Date.now() };
          return doc;
        },
        (error: unknown) => {
          this.metadataFailedAt = Date.now();
          this.logger.warn(`authorization server metadata fetch failed: ${error instanceof Error ? error.message : String(error)}`);
          if (this.metadataCache) return this.metadataCache.doc;
          throw error;
        },
      )
      .finally(() => {
        this.metadataInFlight = null;
      });
    return this.metadataInFlight;
  }

  private async fetchMetadata(): Promise<Record<string, unknown>> {
    const s = this.settings!;
    const res = await this.boundedFetch(`${trimSlash(s.issuer)}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`metadata answered ${res.status}`);
    let doc: unknown;
    try {
      doc = JSON.parse(await res.text());
    } catch {
      throw new Error('metadata is not JSON');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('metadata is not a JSON object');
    const record = doc as Record<string, unknown>;
    if (record.issuer !== s.issuer) throw new Error('metadata issuer differs from OAUTH_AUTHORIZATION_SERVER');
    if (!s.jwksUrl && !fetchableUrl(record.jwks_uri, s.production)) throw new Error('metadata has no usable jwks_uri');
    return record;
  }

  /**
   * One request to a configured URL: no redirects followed, a time limit, and
   * a body cap. The answer is re-wrapped from the capped bytes, so a caller
   * (jose included) can never read more than MAX_BODY_BYTES.
   */
  private async boundedFetch(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(this.fetchTimeoutMs),
    });
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error('response too large');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response too large');
      }
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' } });
  }

  /** The key set, from OAUTH_JWKS_URL or the metadata's `jwks_uri`; jose caches and refreshes it. */
  private async keys(): Promise<JWTVerifyGetKey> {
    const s = this.settings!;
    const url = s.jwksUrl ?? fetchableUrl((await this.authorizationServerMetadata()).jwks_uri, s.production);
    if (!url) throw new Error('no usable jwks_uri');
    if (this.jwks?.url !== url) {
      this.jwks = {
        url,
        get: createRemoteJWKSet(new URL(url), {
          timeoutDuration: this.fetchTimeoutMs,
          [customFetch]: (input: string, options: RequestInit) => this.boundedFetch(input, options),
        }),
      };
    }
    return this.jwks.get;
  }

  // --- The MCP door ----------------------------------------------------------

  /**
   * An access token from the external server, or null for anything else: a
   * bad signature, another issuer or audience, an expired or not-yet-valid
   * token, an algorithm other than RS256/ES256, a missing `sub` or `exp`, an
   * unknown key, or keys that cannot be fetched right now.
   */
  async verify(token: string): Promise<ExternalLogin | null> {
    const s = this.settings;
    if (!s) return null;
    try {
      const { payload } = await jwtVerify(token, await this.keys(), {
        issuer: s.issuer,
        audience: s.resource,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['sub', 'exp'],
      });
      const subject = payload.sub;
      if (typeof subject !== 'string' || !subject || subject.length > 255 || typeof payload.exp !== 'number') return null;
      const clientId = logValue(payload.client_id) ?? logValue(payload.azp);
      const sessionId = logValue(payload.sid);
      return {
        subject,
        expiresAtMs: payload.exp * 1000,
        ...(clientId ? { clientId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * The accounts a sign-in may act in: one per member of the person behind
   * its subject who was seen on the web within the window and is active and
   * an owner or admin. Read on every request, never cached.
   */
  async accountsFor(subject: string): Promise<LoginAccount[]> {
    const memberships = await membershipsBySubject(this.db, subject, Date.now() - this.settings!.linkMaxAgeMs);
    return memberships
      .filter((m) => mayAct(m))
      .map((m) => ({ accountId: m.accountId, accountName: m.accountName, memberId: m.memberId }));
  }
}
