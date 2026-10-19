import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadServerEnv, oauthConfigProblems, serverEnvSchema } from '@slate/config/env';
import {
  BASELINE_SCOPES,
  cimdFetchAllowed,
  dcrRedirectAllowed,
  isSpecialUseAddress,
  loadSigningKey,
  oauthScopesFrom,
  resolveOAuthSettings,
  resourceMetadataUrlFor,
  sameResource,
} from './oauth.settings';
import { toolCallNeeds } from '../mcp/mcp.controller';

const jwk = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const on = (extra: Record<string, string> = {}) =>
  serverEnvSchema.parse({
    OAUTH_ENABLED: 'true',
    OAUTH_ISSUER: 'https://calendar.example.com',
    MCP_PUBLIC_URL: 'https://calendar.example.com/mcp',
    OAUTH_SIGNING_JWK: JSON.stringify(jwk()),
    ...extra,
  });

describe('OAuth configuration fails fast', () => {
  it('off by default, and a bare fork boots', () => {
    const env = loadServerEnv({});
    expect(env.OAUTH_ENABLED).toBe(false);
    expect(oauthConfigProblems(env)).toEqual([]);
    expect(resolveOAuthSettings(env)).toBeNull();
  });

  it('refuses to boot with OAUTH_ENABLED and anything missing, naming each problem', () => {
    expect(() => loadServerEnv({ OAUTH_ENABLED: 'true' })).toThrow(/MCP_PUBLIC_URL is required[\s\S]*OAUTH_ISSUER is required[\s\S]*OAUTH_SIGNING_JWK is required/);
  });

  it('wants an https origin issuer, an https resource and a private P-256 key', () => {
    const pub = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
    const problems = (extra: Record<string, string>) => oauthConfigProblems(on(extra)).join(' | ');
    expect(problems({ OAUTH_ISSUER: 'https://calendar.example.com/oauth' })).toContain('origin only');
    expect(problems({ OAUTH_ISSUER: 'http://calendar.example.com', NODE_ENV: 'development' })).toContain('https');
    expect(problems({ MCP_PUBLIC_URL: 'http://calendar.example.com/mcp' })).toContain('https');
    expect(problems({ OAUTH_ISSUER: 'http://localhost:4000', MCP_PUBLIC_URL: 'http://localhost:4000/mcp' })).toBe('');
    expect(problems({ OAUTH_ISSUER: 'http://localhost:4000', MCP_PUBLIC_URL: 'http://localhost:4000/mcp', NODE_ENV: 'production', AUTH_PROVIDER: 'workos' })).toContain('https');
    expect(problems({ OAUTH_SIGNING_JWK: JSON.stringify(pub) })).toContain('PRIVATE');
    expect(problems({ OAUTH_SIGNING_JWK: JSON.stringify(rsa) })).toContain('PRIVATE');
    expect(problems({ OAUTH_SIGNING_JWK: 'not json' })).toContain('JSON object');
    expect(problems({ MCP_ENABLED: 'false' })).toContain('MCP_ENABLED');
    expect(problems({})).toBe('');
  });

  it('resolves the settings: origin issuer, resource as pasted, metadata URL, TTLs', () => {
    const s = resolveOAuthSettings(on({ OAUTH_ISSUER: 'https://calendar.example.com/', MCP_PUBLIC_URL: 'https://api.example.com/mcp/', OAUTH_GRANT_TTL_DAYS: '30' }))!;
    expect(s.issuer).toBe('https://calendar.example.com');
    expect(s.resource).toBe('https://api.example.com/mcp');
    expect(s.resourceMetadataUrl).toBe('https://api.example.com/.well-known/oauth-protected-resource/mcp');
    expect(s.accessTokenTtlSeconds).toBe(3600);
    expect(s.grantTtlSeconds).toBe(30 * 86_400);
    expect(s.consentUrl).toBe('http://localhost:3000/auth/consent');
    expect(s.cookieKeys[0]).toHaveLength(43);
  });
});

describe('signing key', () => {
  it('re-derives the public half from d, so a mismatched x/y can never be published', () => {
    const a = jwk();
    const b = jwk();
    const { signingJwk, publicJwk } = loadSigningKey(JSON.stringify({ ...a, x: b.x, y: b.y }));
    expect(publicJwk.x).toBe(a.x);
    expect(publicJwk.y).toBe(a.y);
    expect(signingJwk.d).toBe(a.d);
    expect('d' in publicJwk).toBe(false);
    expect(publicJwk).toMatchObject({ alg: 'ES256', use: 'sig' });
    // A stable kid without one configured, the configured one otherwise.
    expect(loadSigningKey(JSON.stringify(a)).publicJwk.kid).toBe(publicJwk.kid);
    expect(loadSigningKey(JSON.stringify({ ...a, kid: 'k1' })).publicJwk.kid).toBe('k1');
  });

  it('refuses anything that is not a P-256 private key', () => {
    expect(() => loadSigningKey(JSON.stringify({ kty: 'EC', crv: 'P-384', d: 'x' }))).toThrow();
    expect(() => loadSigningKey(JSON.stringify({ ...jwk(), d: 'AAAA' }))).toThrow();
  });
});

describe('resources and scopes', () => {
  it('treats a trailing slash as the same resource and anything else as different', () => {
    expect(sameResource('https://a.example/mcp', 'https://a.example/mcp/')).toBe(true);
    expect(sameResource('https://a.example:443/mcp', 'https://a.example/mcp')).toBe(true);
    expect(sameResource('https://a.example/mcp', 'https://a.example/mcp2')).toBe(false);
    expect(sameResource('https://b.example/mcp', 'https://a.example/mcp')).toBe(false);
    expect(sameResource('not a url', 'https://a.example/mcp')).toBe(false);
  });

  it('places the protected-resource metadata per RFC 9728', () => {
    expect(resourceMetadataUrlFor('https://a.example/mcp')).toBe('https://a.example/.well-known/oauth-protected-resource/mcp');
    expect(resourceMetadataUrlFor('https://a.example')).toBe('https://a.example/.well-known/oauth-protected-resource');
  });

  it('reads only known scopes, in catalog order', () => {
    expect(oauthScopesFrom('bookings:cancel openid calendars:read event-types:read event-types:read')).toEqual(['event-types:read', 'bookings:cancel']);
    expect(oauthScopesFrom(undefined)).toEqual([]);
    expect(BASELINE_SCOPES).toEqual(['event-types:read', 'availability:read', 'bookings:read']);
  });
});

describe('registration redirect allowlist', () => {
  it('matches the allowlist exactly and loopback with any port', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'https://vscode.dev/redirect',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'http://localhost:3118/callback',
      'http://localhost/callback',
      'http://127.0.0.1:33418/',
      'http://127.0.0.1:9000/any/path',
    ])
      expect(dcrRedirectAllowed(ok), ok).toBe(true);
    for (const bad of [
      'https://claude.ai/api/mcp/auth_callback?x=1',
      'https://claude.ai/api/mcp/auth_callback#f',
      'https://claude.ai/api/mcp/auth_callback/',
      'https://cursor.com/agents/mcp/oauth/callback',
      'http://localhost:3118/callback?next=evil',
      'http://localhost:3118/other',
      'http://127.0.0.1.evil.test/cb',
      'http://u:p@127.0.0.1/cb',
      'https://localhost/callback',
      'javascript:alert(1)',
    ])
      expect(dcrRedirectAllowed(bad), bad).toBe(false);
    expect(dcrRedirectAllowed('https://x.example/cb', new Set(['https://x.example/cb']))).toBe(true);
  });
});

describe('client metadata document fetch guard', () => {
  it('knows the special-use ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '224.0.0.1', '2001:db8::1'])
      expect(isSpecialUseAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isSpecialUseAddress(ip), ip).toBe(false);
    expect(isSpecialUseAddress('not-an-ip')).toBe(true);
  });

  it('refuses an explicit port, plain http, IP literals in private ranges and names that resolve to them', async () => {
    const resolves = (map: Record<string, string[]>) => async (host: string) => {
      if (!map[host]) throw new Error('ENOTFOUND');
      return map[host]!.map((address) => ({ address }));
    };
    const lookup = resolves({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.0.0.8'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] });
    expect(await cimdFetchAllowed('https://public.example/client.json', lookup)).toBe(true);
    expect(await cimdFetchAllowed('https://internal.example/client.json', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://mixed.example/client.json', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://nowhere.example/client.json', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://public.example:8443/client.json', lookup)).toBe(false);
    expect(await cimdFetchAllowed('http://public.example/client.json', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://169.254.169.254/latest', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://[::1]/c', lookup)).toBe(false);
    expect(await cimdFetchAllowed('https://8.8.8.8/c', lookup)).toBe(true);
  });
});

describe('which tool calls need a credential', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('reads the scope each call needs, public tools need nothing, other methods are ignored', () => {
    expect(toolCallNeeds(call('list_bookings'))).toEqual({ credential: true, scopes: ['bookings:read'] });
    expect(toolCallNeeds(call('whoami'))).toEqual({ credential: true, scopes: [] });
    expect(toolCallNeeds(call('book_meeting'))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('find_available_slots', { booking_page_url: 'https://x.test/a/b/c' }))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('find_available_slots', { event_type_id: 'e1' }))).toEqual({ credential: true, scopes: ['availability:read'] });
    expect(toolCallNeeds({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(call('no_such_tool'))).toEqual({ credential: false, scopes: [] });
    expect(toolCallNeeds(null)).toEqual({ credential: false, scopes: [] });
  });

  it('collects every scope a batch needs', () => {
    expect(toolCallNeeds([call('create_booking'), call('cancel_booking'), call('book_meeting')])).toEqual({
      credential: true,
      scopes: ['bookings:write', 'bookings:cancel'],
    });
  });
});
