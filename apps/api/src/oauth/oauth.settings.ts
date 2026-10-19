import { createECDH, createHash, createPrivateKey, hkdfSync, type JsonWebKey } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ServerEnv } from '@slate/config/env';
import type { ApiScope } from '@slate/types';

/**
 * Everything the OAuth authorization server is configured from, resolved once
 * from the environment and checked: pure, no I/O, so it is unit-tested apart
 * from oidc-provider. `loadServerEnv` has already refused a half-configured
 * OAUTH_ENABLED; this turns the strings into the values the server runs on.
 */

/** Where oidc-provider is mounted inside the Nest app. */
export const OAUTH_MOUNT = '/oauth';

/**
 * Requests whose body oidc-provider parses itself. Everything under the mount
 * except our own interaction routes, which are GETs without a body anyway.
 */
export const oidcOwnsBody = (path: string): boolean => path === OAUTH_MOUNT || path.startsWith(`${OAUTH_MOUNT}/`);

/**
 * The scopes an OAuth connection can hold: exactly the ones the MCP tools
 * check, so a connection can never be granted more than the tools use.
 * (`calendars:read` exists for API keys on the REST surface; no MCP tool reads it.)
 */
export const OAUTH_SCOPES = [
  'event-types:read',
  'availability:read',
  'bookings:read',
  'bookings:write',
  'bookings:cancel',
] as const satisfies readonly ApiScope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * The minimal set: what the protected-resource metadata advertises and what a
 * first connection asks for. Read-only; writes and cancel arrive by step-up
 * (a 403 `insufficient_scope` naming them) when a tool needs them.
 */
export const BASELINE_SCOPES = ['event-types:read', 'availability:read', 'bookings:read'] as const satisfies readonly OAuthScope[];

export const isOAuthScope = (s: string): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s);

/** Scopes from a space-delimited string, deduplicated, in catalog order. */
export function oauthScopesFrom(value: unknown): OAuthScope[] {
  const asked = new Set(typeof value === 'string' ? value.split(' ') : []);
  return OAUTH_SCOPES.filter((s) => asked.has(s));
}

/**
 * Redirect URIs a dynamically registered client may use, matched EXACTLY.
 * Each is a client documented to register this way: Claude (web, desktop,
 * mobile), Cursor's hosted agents, VS Code for the web, and ChatGPT's stable
 * callback (which it uses because this server sends RFC 9207 `iss`).
 * Loopback redirects (Claude Code, Cursor desktop, VS Code desktop) are matched
 * by `dcrRedirectAllowed` with any port.
 */
export const DCR_REDIRECT_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'https://vscode.dev/redirect',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

export interface OAuthSettings {
  /** The issuer origin, no trailing slash. The `iss` of tokens and authorization responses. */
  issuer: string;
  /** The MCP endpoint URL as people paste it: the token audience. */
  resource: string;
  /** Where the protected-resource metadata for `resource` lives (RFC 9728). */
  resourceMetadataUrl: string;
  /** Private signing key for oidc-provider's keystore (public half re-derived from `d`). */
  signingJwk: JsonWebKey & { kid: string; alg: 'ES256'; use: 'sig' };
  /** The public half, for verifying access tokens at the MCP door. */
  publicJwk: JsonWebKey & { kid: string; alg: 'ES256'; use: 'sig' };
  /** Keys for oidc-provider's signed cookies, derived from the signing key. */
  cookieKeys: string[];
  accessTokenTtlSeconds: number;
  grantTtlSeconds: number;
  refreshGraceSeconds: number;
  cimd: boolean;
  dcr: boolean;
  /** Exact redirect URIs added to the registration allowlist by the operator. */
  extraRedirects: ReadonlySet<string>;
  /** The web page that asks the signed-in person to approve or deny. */
  consentUrl: string;
}

/** A URL without a trailing slash (an origin, or a path). */
export const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** The same resource, written with or without a trailing slash or default port. */
export function sameResource(a: string, b: string): boolean {
  try {
    return trimSlash(new URL(a).href) === trimSlash(new URL(b).href);
  } catch {
    return false;
  }
}

/** RFC 9728 §3.1: the metadata URL inserts `/.well-known/oauth-protected-resource` before the resource path. */
export function resourceMetadataUrlFor(resource: string): string {
  const url = new URL(resource);
  const path = trimSlash(url.pathname);
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Load the signing key and re-derive its public half from the private scalar,
 * so a JWK whose `x`/`y` do not belong to its `d` can never put a key in the
 * JWKS that differs from the one that signs. Throws on anything that is not a
 * usable P-256 private key.
 */
export function loadSigningKey(raw: string): { signingJwk: OAuthSettings['signingJwk']; publicJwk: OAuthSettings['publicJwk'] } {
  const parsed = JSON.parse(raw) as JsonWebKey & { kid?: unknown };
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || typeof parsed.d !== 'string')
    throw new Error('OAUTH_SIGNING_JWK must be an EC P-256 private JWK.');
  const d = Buffer.from(parsed.d, 'base64url');
  if (d.length !== 32) throw new Error('OAUTH_SIGNING_JWK has a malformed private scalar (d).');
  // The public point FROM d (Node's JWK import would trust the x/y it is given).
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const x = point.subarray(1, 33).toString('base64url');
  const y = point.subarray(33, 65).toString('base64url');
  // Throws if the result is not a usable key.
  createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: parsed.d, x, y }, format: 'jwk' });
  // RFC 7638 thumbprint when the operator gave no kid: stable across replicas.
  const kid =
    typeof parsed.kid === 'string' && parsed.kid
      ? parsed.kid
      : createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x, y })).digest('base64url');
  const publicJwk = { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256' as const, use: 'sig' as const };
  return { signingJwk: { ...publicJwk, d: parsed.d }, publicJwk };
}

/** The settings, or null when OAuth is off. */
export function resolveOAuthSettings(env: ServerEnv): OAuthSettings | null {
  if (!env.OAUTH_ENABLED || !env.OAUTH_ISSUER || !env.MCP_PUBLIC_URL || !env.OAUTH_SIGNING_JWK) return null;
  const { signingJwk, publicJwk } = loadSigningKey(env.OAUTH_SIGNING_JWK);
  const cookieKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(signingJwk.d!, 'base64url'), 'dapta-calendars', 'oauth-cookie-signing', 32),
  ).toString('base64url');
  const resource = trimSlash(new URL(env.MCP_PUBLIC_URL).href);
  const extraRedirects = new Set(
    (env.OAUTH_DCR_EXTRA_REDIRECT_URIS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    issuer: new URL(env.OAUTH_ISSUER).origin,
    resource,
    resourceMetadataUrl: resourceMetadataUrlFor(resource),
    signingJwk,
    publicJwk,
    cookieKeys: [cookieKey],
    accessTokenTtlSeconds: env.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    grantTtlSeconds: env.OAUTH_GRANT_TTL_DAYS * 86_400,
    refreshGraceSeconds: env.OAUTH_REFRESH_REUSE_GRACE_SECONDS,
    cimd: env.OAUTH_CIMD_ENABLED,
    dcr: env.OAUTH_DCR_ENABLED,
    extraRedirects,
    consentUrl: `${trimSlash(env.PUBLIC_APP_URL)}/auth/consent`,
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An `http://` redirect to this machine (RFC 8252 §7.3), any port. */
export function isLoopbackRedirect(uri: string): boolean {
  const url = URL.parse(uri);
  return !!url && url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

/**
 * Whether a dynamically registered client may use this redirect URI. Exact
 * string match against the allowlist (and the operator's extras); loopback is
 * `http://localhost:<any port>/callback` or `http://127.0.0.1:<any port>/<any
 * path>`, never with credentials, a query or a fragment.
 */
export function dcrRedirectAllowed(uri: string, extra: ReadonlySet<string> = new Set()): boolean {
  if (DCR_REDIRECT_ALLOWLIST.includes(uri) || extra.has(uri)) return true;
  const url = URL.parse(uri);
  if (!url || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || uri.includes('#')) return false;
  if (url.hostname === 'localhost') return url.pathname === '/callback';
  return url.hostname === '127.0.0.1';
}

/**
 * Addresses a client metadata document may never be fetched from: private,
 * loopback, link-local, shared, documentation, multicast and other
 * special-use ranges (IANA special-purpose registries). Node's BlockList does
 * the matching.
 */
const SPECIAL_USE = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ] as const)
    list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** Whether an IP literal is in a special-use range (IPv4-mapped IPv6 judged as its IPv4). */
export function isSpecialUseAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  const family = isIP(ip);
  if (family === 4) return SPECIAL_USE.check(ip, 'ipv4');
  if (family === 6) return SPECIAL_USE.check(ip, 'ipv6');
  return true;
}

export type Lookup = (hostname: string) => Promise<{ address: string }[]>;

const systemLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Whether this server may fetch a client metadata document from `clientId`.
 * oidc-provider already requires https, refuses special-use addresses on the
 * connected socket (so DNS rebinding cannot get a request through) and caps
 * size and time. Its socket check runs after the TLS handshake, though, so a
 * private host would still see a connection attempt and its timing would tell
 * an open port from a closed one. This refuses earlier: no explicit port, and
 * every address the name resolves to must be public.
 */
export async function cimdFetchAllowed(clientId: string, lookup: Lookup = systemLookup): Promise<boolean> {
  const url = URL.parse(clientId);
  if (!url || url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isSpecialUseAddress(host);
  try {
    const addresses = await lookup(host);
    return addresses.length > 0 && addresses.every((a) => !isSpecialUseAddress(a.address));
  } catch {
    return false;
  }
}
