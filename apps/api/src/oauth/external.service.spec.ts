import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportSPKI, generateKeyPair } from 'jose';
import { createDb, migrate, seed, type Db } from '@slate/db';
import { loadServerEnv, oauthConfigProblems, oauthMode, serverEnvSchema } from '@slate/config/env';
import { ExternalOAuthService, resolveExternalSettings } from './external.service';
import { startFakeAs, type FakeAs } from './fake-as';
import { resolveOAuthSettings } from './oauth.settings';

const RESOURCE = 'https://calendar.example.test/mcp';

let as: FakeAs;
let db: Db;
beforeAll(async () => {
  as = await startFakeAs({ audience: RESOURCE });
  db = await createDb('file::memory:');
  await migrate(db);
  await seed(db);
});
afterAll(async () => {
  await as.close();
  await db.close();
});
afterEach(() => {
  as.modes.metadata = 'ok';
  as.modes.jwks = 'ok';
});

function service(extra: Record<string, string> = {}): ExternalOAuthService {
  const env = loadServerEnv({
    NODE_ENV: 'test',
    OAUTH_ENABLED: 'true',
    OAUTH_AUTHORIZATION_SERVER: as.issuer,
    MCP_PUBLIC_URL: RESOURCE,
    ...extra,
  });
  return new ExternalOAuthService(env, db);
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('configuration', () => {
  const on = (extra: Record<string, string>) =>
    serverEnvSchema.parse({ OAUTH_ENABLED: 'true', MCP_PUBLIC_URL: RESOURCE, OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.test', ...extra });
  const problems = (extra: Record<string, string> = {}) => oauthConfigProblems(on(extra)).join(' | ');

  it('needs no issuer or signing key of its own, and the built-in server stays unbuilt even when they are set', () => {
    expect(problems()).toBe('');
    const env = on({ OAUTH_ISSUER: 'https://calendar.example.test', OAUTH_SIGNING_JWK: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })) });
    expect(oauthMode(env)).toBe('external');
    expect(resolveOAuthSettings(env)).toBeNull();
    expect(resolveExternalSettings(env)).toMatchObject({ issuer: 'https://auth.example.test', resource: RESOURCE });
  });

  it('refuses a malformed authorization server at boot', () => {
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'http://auth.example.test' })).toContain('https');
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.test/tenant' })).toContain('origin only');
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.test/?x=1' })).toContain('origin only');
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'https://user:pw@auth.example.test' })).toContain('origin only');
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'http://localhost:9000' })).toBe('');
    expect(problems({ OAUTH_AUTHORIZATION_SERVER: 'http://localhost:9000', NODE_ENV: 'production', AUTH_PROVIDER: 'workos' })).toContain('https');
    expect(problems({ OAUTH_JWKS_URL: 'http://keys.example.test/jwks' })).toContain('OAUTH_JWKS_URL must use https');
    expect(problems({ MCP_PUBLIC_URL: '' })).toContain('MCP_PUBLIC_URL is required');
    expect(() => loadServerEnv({ OAUTH_ENABLED: 'true', MCP_PUBLIC_URL: RESOURCE, OAUTH_AUTHORIZATION_SERVER: 'not a url' })).toThrow(/OAUTH_AUTHORIZATION_SERVER/);
    expect(() => loadServerEnv({ OAUTH_ENABLED: 'true', MCP_PUBLIC_URL: RESOURCE, OAUTH_AUTHORIZATION_SERVER: 'ftp://auth.example.test' })).toThrow(/https/);
  });

  it('is off without OAUTH_ENABLED, whatever else is set', () => {
    const env = serverEnvSchema.parse({ OAUTH_AUTHORIZATION_SERVER: 'https://auth.example.test', MCP_PUBLIC_URL: RESOURCE });
    expect(oauthMode(env)).toBe('off');
    expect(resolveExternalSettings(env)).toBeNull();
  });
});

describe('discovery', () => {
  it('publishes the external server from configuration, never from a request', () => {
    const s = service();
    expect(s.protectedResourceMetadata()).toEqual({
      resource: RESOURCE,
      authorization_servers: [as.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
      resource_name: 'Dapta Calendars',
    });
    expect(s.challenge()).toBe('Bearer resource_metadata="https://calendar.example.test/.well-known/oauth-protected-resource/mcp"');
    expect(s.challenge('invalid_token', 'Bad "token"')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://calendar.example.test/.well-known/oauth-protected-resource/mcp", error_description="Bad token"',
    );
  });

  it('fetches the server metadata once and serves it from cache', async () => {
    const s = service();
    const before = as.hits['/.well-known/oauth-authorization-server'] ?? 0;
    const [a, b] = await Promise.all([s.authorizationServerMetadata(), s.authorizationServerMetadata()]);
    await s.authorizationServerMetadata();
    expect(a).toEqual(b);
    expect(a.issuer).toBe(as.issuer);
    expect(a.client_id_metadata_document_supported).toBe(true);
    expect(as.hits['/.well-known/oauth-authorization-server']).toBe(before + 1);
  });

  it('refuses metadata naming another issuer, an oversized body and a redirect', async () => {
    for (const mode of ['wrong-issuer', 'huge', 'redirect', 'error'] as const) {
      as.modes.metadata = mode;
      await expect(service().authorizationServerMetadata()).rejects.toThrow();
    }
  });

  it('after a failure, waits before asking again, and keeps serving the last good document', async () => {
    const s = service();
    as.modes.metadata = 'error';
    await expect(s.authorizationServerMetadata()).rejects.toThrow();
    const after = as.hits['/.well-known/oauth-authorization-server'];
    await expect(s.authorizationServerMetadata()).rejects.toThrow('unavailable');
    expect(as.hits['/.well-known/oauth-authorization-server']).toBe(after);

    const good = service();
    as.modes.metadata = 'ok';
    const doc = await good.authorizationServerMetadata();
    // An hour later the refresh fails: the last good document still answers.
    (good as unknown as { metadataCache: { at: number } }).metadataCache.at -= 2 * 3_600_000;
    as.modes.metadata = 'error';
    expect(await good.authorizationServerMetadata()).toEqual(doc);
  });

  it('times out a stalled metadata request', async () => {
    const s = service();
    s.fetchTimeoutMs = 200;
    as.modes.metadata = 'stall';
    const started = Date.now();
    await expect(s.authorizationServerMetadata()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('verifying an access token', () => {
  it('accepts RS256 and ES256 tokens for this resource, reading only sub and exp (plus client and session for the log)', async () => {
    const s = service();
    const rs = await s.verify(await as.mint({ client_id: 'https://client.example.test/meta', sid: 'session_1' }));
    expect(rs).toMatchObject({ subject: 'user_01TESTSUBJECT', clientId: 'https://client.example.test/meta', sessionId: 'session_1' });
    expect(rs!.expiresAtMs).toBeGreaterThan(Date.now());
    expect(await s.verify(await as.mint({ azp: 'client_azp' }, { alg: 'ES256' }))).toMatchObject({ clientId: 'client_azp' });
    // An audience list that contains this resource is fine.
    expect(await s.verify(await as.mint({ aud: ['https://other.example.test', RESOURCE] }))).not.toBeNull();
  });

  it('refuses another issuer or audience, expired or not-yet-valid tokens and a missing subject', async () => {
    const s = service();
    const now = Math.floor(Date.now() / 1000);
    expect(await s.verify(await as.mint({ iss: 'https://evil.example.test' }))).toBeNull();
    expect(await s.verify(await as.mint({ iss: `${as.issuer}/` }))).toBeNull();
    expect(await s.verify(await as.mint({ aud: 'https://calendar.example.test/mcp/other' }))).toBeNull();
    expect(await s.verify(await as.mint({ aud: 'https://calendar.example.test' }))).toBeNull();
    expect(await s.verify(await as.mint({ exp: now - 120 }))).toBeNull();
    expect(await s.verify(await as.mint({ nbf: now + 600 }))).toBeNull();
    expect(await s.verify(await as.mint({ sub: null }))).toBeNull();
    expect(await s.verify(await as.mint({ exp: null }))).toBeNull();
    expect(await s.verify('not.a.token')).toBeNull();
    expect(await s.verify('')).toBeNull();
  });

  it('refuses alg none, HS256 keyed with the public key, an unknown kid and a foreign key under a known kid', async () => {
    const s = service();
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: as.issuer, aud: RESOURCE, sub: 'user_01TESTSUBJECT', exp: now + 300 };
    expect(await s.verify(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`)).toBeNull();

    const rsa = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportSPKI(rsa.publicKey);
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' }).sign(new TextEncoder().encode(pem));
    expect(await s.verify(hs)).toBeNull();
    const hsJwk = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' }).sign(new TextEncoder().encode(JSON.stringify(as.publicJwk)));
    expect(await s.verify(hsJwk)).toBeNull();

    expect(await s.verify(await as.mint({}, { kid: 'rotated-away', key: rsa.privateKey }))).toBeNull();
    expect(await s.verify(await as.mint({}, { kid: 'rsa-1', key: rsa.privateKey }))).toBeNull();
    // A valid token still passes after all of that.
    expect(await s.verify(await as.mint())).not.toBeNull();
  });

  it('a JWKS that times out or fails verifies nothing (no throw)', async () => {
    const stalled = service();
    stalled.fetchTimeoutMs = 200;
    as.modes.jwks = 'stall';
    const started = Date.now();
    expect(await stalled.verify(await as.mint())).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);

    as.modes.jwks = 'error';
    expect(await service().verify(await as.mint())).toBeNull();
    as.modes.jwks = 'huge';
    expect(await service().verify(await as.mint())).toBeNull();
    as.modes.jwks = 'redirect';
    expect(await service().verify(await as.mint())).toBeNull();
  });

  it('metadata that cannot be fetched or names another issuer verifies nothing', async () => {
    as.modes.metadata = 'error';
    expect(await service().verify(await as.mint())).toBeNull();
    as.modes.metadata = 'wrong-issuer';
    expect(await service().verify(await as.mint())).toBeNull();
  });

  it('with OAUTH_JWKS_URL the keys come from there and the metadata is never fetched', async () => {
    const s = service({ OAUTH_JWKS_URL: as.jwksUrl });
    as.modes.metadata = 'error';
    const before = as.hits['/.well-known/oauth-authorization-server'] ?? 0;
    expect(await s.verify(await as.mint())).not.toBeNull();
    expect(as.hits['/.well-known/oauth-authorization-server'] ?? 0).toBe(before);
  });

  it('fetches the keys once for many tokens', async () => {
    const s = service();
    await s.verify(await as.mint());
    const before = as.hits['/oauth2/jwks'];
    for (let i = 0; i < 5; i += 1) expect(await s.verify(await as.mint())).not.toBeNull();
    expect(as.hits['/oauth2/jwks']).toBe(before);
  });
});
