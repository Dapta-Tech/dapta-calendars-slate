import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { sql } from '@slate/db';
import { bootHarness, type Harness } from '../mcp/mcp-harness';
import type { ConsentDetails } from './oauth.service';
import {
  authorizeAndApprove,
  authorizeUrl,
  bootOAuth,
  Browser,
  callTool,
  connect,
  decide,
  exchange,
  followDecision,
  pkce,
  publicClient,
  refresh,
  registerClient,
  startAuthorization,
  toolResult,
  type Client,
  type OAuthHarness,
} from './oauth-harness';

/**
 * The OAuth authorization server end to end over HTTP, on the whole AppModule
 * (every `@Inject` exercised the way tsx runs it). The browser is simulated
 * with a path-aware cookie jar; the consent page's two API calls are made with
 * the host identity the local auth stub honours in tests.
 */

const READ = 'event-types:read availability:read bookings:read';

const open: Harness[] = [];
async function boot(env: Parameters<typeof bootOAuth>[0] = {}): Promise<OAuthHarness> {
  const h = await bootOAuth(env);
  open.push(h);
  return h;
}
afterAll(async () => {
  await Promise.all(open.map((h) => h.close()));
});

/** Sign an access-token-shaped JWT with a key of our choice, to probe the door. */
async function forge(h: OAuthHarness, claims: Record<string, unknown>, opts: { key?: 'ours' | 'foreign'; typ?: string } = {}) {
  const jwk =
    opts.key === 'foreign'
      ? (generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, unknown>)
      : (h.oauth.settings!.signingJwk as unknown as Record<string, unknown>);
  const key = await importJWK(jwk, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    account_id: h.accountId,
    grant_id: 'forged-grant',
    client_id: 'forged-client',
    scope: READ,
    jti: randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', typ: opts.typ ?? 'at+jwt', kid: h.oauth.settings!.publicJwk.kid })
    .setIssuer((claims.iss as string) ?? h.issuer)
    .setAudience((claims.aud as string) ?? h.resource)
    .setSubject(h.ownerIds.memberId)
    .setIssuedAt(now - 10)
    .setExpirationTime((claims.exp as number) ?? now + 600)
    .sign(key);
}

describe('discovery', () => {
  let h: OAuthHarness;
  beforeAll(async () => {
    h = await boot();
  });

  it('serves RFC 8414 metadata built from the issuer, with PKCE S256, iss, CIMD and DCR', async () => {
    const res = await fetch(`${h.issuer}/.well-known/oauth-authorization-server`, { headers: { host: 'attacker.test' } });
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      issuer: h.issuer,
      authorization_endpoint: `${h.issuer}/oauth/authorize`,
      token_endpoint: `${h.issuer}/oauth/token`,
      registration_endpoint: `${h.issuer}/oauth/register`,
      revocation_endpoint: `${h.issuer}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      response_types_supported: ['code'],
    });
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
    expect(m.scopes_supported).toEqual([...READ.split(' '), 'bookings:write', 'bookings:cancel', 'offline_access']);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves RFC 9728 metadata at the root and the path-suffixed form, minimal scopes, no offline_access', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${h.issuer}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: h.resource,
        authorization_servers: [h.issuer],
        scopes_supported: READ.split(' '),
        bearer_methods_supported: ['header'],
        resource_name: 'Dapta Calendars',
      });
    }
  });

  it('publishes the public signing key only', async () => {
    const jwks = (await (await fetch(`${h.issuer}/oauth/jwks`)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: h.oauth.settings!.publicJwk.kid });
    expect(jwks.keys[0]!.d).toBeUndefined();
  });

  it('everything OAuth is a 404 while OAUTH_ENABLED is off, and the MCP door keeps its Phase 1 answers', async () => {
    const off = await bootHarness();
    open.push(off);
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/oauth/authorize', '/oauth/jwks']) {
      expect((await fetch(`${off.base}${path}`)).status).toBe(404);
    }
    const res = await off.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_bookings', arguments: {} } });
    expect(res.status).toBe(200);
    const body = await toolResult(res);
    expect(body.isError).toBe(true);
    expect(body.content?.[0]?.text).toContain('AUTH_REQUIRED');
  });
});

describe('authorization code flow with PKCE', () => {
  let h: OAuthHarness;
  let client: Client;
  beforeAll(async () => {
    h = await boot();
    client = await publicClient(h);
  });

  it('issues a short-lived audience-bound JWT and a refresh token, with iss in the authorization response', async () => {
    const { back, code, verifier } = await authorizeAndApprove(h, client, { state: 'xyz' });
    expect(`${back.origin}${back.pathname}`).toBe(client.redirect);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(h.issuer);
    const t = await exchange(h, client, code!, verifier);
    expect(t.status).toBe(200);
    expect(t.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: READ });
    expect(typeof t.json.refresh_token).toBe('string');
    const [header, payload] = String(t.json.access_token)
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    expect(payload).toMatchObject({ iss: h.issuer, aud: h.resource, sub: h.ownerIds.memberId, account_id: h.accountId, client_id: client.client_id });
    expect(Number(payload!.exp) - Number(payload!.iat)).toBe(3600);
  });

  it('works without a resource parameter (defaults to the MCP resource) and on a loopback port the client never registered', async () => {
    // Native apps (RFC 8252) listen on an ephemeral port: only the port may differ.
    const redirect = 'http://localhost:51515/callback';
    const { code, verifier } = await authorizeAndApprove(h, client, { resource: null, redirect });
    const t = await exchange(h, { ...client, redirect }, code!, verifier);
    expect(t.status).toBe(200);
    const payload = JSON.parse(Buffer.from(String(t.json.access_token).split('.')[1]!, 'base64url').toString()) as { aud: string };
    expect(payload.aud).toBe(h.resource);
  });

  it('requires PKCE, and only S256', async () => {
    const browser = new Browser(h.issuer);
    const noChallenge = new URL(authorizeUrl(h, client));
    noChallenge.searchParams.delete('code_challenge');
    noChallenge.searchParams.delete('code_challenge_method');
    const a = await browser.get(noChallenge.href);
    expect(a.res.status).toBe(303);
    expect(new URL(a.location!).searchParams.get('error')).toBe('invalid_request');
    expect(new URL(a.location!).searchParams.get('iss')).toBe(h.issuer);

    const plain = new URL(authorizeUrl(h, client));
    plain.searchParams.set('code_challenge_method', 'plain');
    const b = await browser.get(plain.href);
    expect(new URL(b.location!).searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a wrong code verifier without spending the code; a code spent twice revokes what it issued', async () => {
    const { code, verifier } = await authorizeAndApprove(h, client);
    const wrong = await exchange(h, client, code!, pkce().verifier);
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe('invalid_grant');
    const right = await exchange(h, client, code!, verifier);
    expect(right.status).toBe(200);
    const replay = await exchange(h, client, code!, verifier);
    expect(replay.json.error).toBe('invalid_grant');
    // RFC 6749 §4.1.2: a replayed code revokes the tokens it already produced.
    expect((await refresh(h, client, String(right.json.refresh_token))).json.error).toBe('invalid_grant');
  });

  it('refuses a redirect that does not match exactly, without redirecting to it', async () => {
    const browser = new Browser(h.issuer);
    for (const redirect of ['http://localhost:7777/elsewhere', 'https://evil.test/callback']) {
      const res = await browser.get(authorizeUrl(h, client, { redirect }));
      expect(res.res.status).toBe(400);
      expect(res.location).toBeNull();
    }
  });

  it('refuses a resource other than the MCP endpoint', async () => {
    const browser = new Browser(h.issuer);
    const res = await browser.get(authorizeUrl(h, client, { resource: 'https://other.example/api' }));
    expect(new URL(res.location!).searchParams.get('error')).toBe('invalid_target');
  });

  it('a request that names no scope gets the read-only default', async () => {
    const t = await connect(h, client, { scope: '' });
    expect(t.scope).toBe(READ);
  });

  it('consent denied answers access_denied to the client, with iss and state', async () => {
    const started = await startAuthorization(h, client, { state: 'deny-me' });
    const res = await decide(h, started.uid, 'deny');
    expect(res.status).toBe(200);
    const back = await followDecision(started, ((await res.json()) as { redirectTo: string }).redirectTo);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('deny-me');
    expect(back.searchParams.get('iss')).toBe(h.issuer);
    expect(back.searchParams.get('code')).toBeNull();
  });
});

describe('consent', () => {
  let h: OAuthHarness;
  let client: Client;
  beforeAll(async () => {
    h = await boot();
    client = await publicClient(h);
  });

  it('shows the client, its host, the redirect host, the account and the scopes in catalog order', async () => {
    const started = await startAuthorization(h, client, { scope: `bookings:write ${READ} offline_access` });
    const res = await fetch(`${h.issuer}/v1/oauth/consent/${started.uid}`, { headers: h.owner });
    expect(res.status).toBe(200);
    const d = (await res.json()) as ConsentDetails;
    expect(d.client).toMatchObject({ id: client.client_id, name: 'Spec Agent', host: 'localhost:7777', via: 'dcr', redirectHost: 'localhost:7777', loopback: true });
    expect(d.scopes).toEqual([...READ.split(' '), 'bookings:write']);
    expect(d.account.code).toBe('acme');
    expect(d.canApprove).toBe(true);
    expect(d.staysConnected).toBe(true);
    expect(d.grantDays).toBe(90);
  });

  it('a plain member sees it but cannot approve; denying is allowed', async () => {
    const started = await startAuthorization(h, client);
    const details = (await (await fetch(`${h.issuer}/v1/oauth/consent/${started.uid}`, { headers: h.member })).json()) as { canApprove: boolean };
    expect(details.canApprove).toBe(false);
    expect((await decide(h, started.uid, 'approve', h.member)).status).toBe(403);
    expect((await decide(h, started.uid, 'deny', h.member)).status).toBe(200);
  });

  it('needs a signed-in host, and an unknown uid is a 404', async () => {
    expect((await fetch(`${h.issuer}/v1/oauth/consent/nope`, { headers: h.owner })).status).toBe(404);
    expect((await decide(h, 'nope', 'approve')).status).toBe(404);
    const bad = await fetch(`${h.issuer}/v1/oauth/consent/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...h.owner },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(bad.status).toBe(400);
  });

  it('a decision completes only in the browser that started the request, and only once', async () => {
    const started = await startAuthorization(h, client);
    const { redirectTo } = (await (await decide(h, started.uid, 'approve')).json()) as { redirectTo: string };
    // Someone else's browser (no interaction cookie) cannot spend the ticket.
    const stranger = await new Browser(h.issuer).get(redirectTo);
    expect(stranger.res.status).toBe(400);
    expect(stranger.location).toBeNull();
    // The right browser still can, exactly once.
    const back = await followDecision(started, redirectTo);
    expect(back.searchParams.get('code')).toBeTruthy();
    const replay = await started.browser.get(redirectTo);
    expect(replay.res.status).toBe(400);
    // And the request is gone for the consent page.
    expect((await fetch(`${h.issuer}/v1/oauth/consent/${started.uid}`, { headers: h.owner })).status).toBe(404);
  });

  it('a ticket for one request cannot finish another', async () => {
    const one = await startAuthorization(h, client);
    const two = await startAuthorization(h, client);
    const { redirectTo } = (await (await decide(h, one.uid, 'approve')).json()) as { redirectTo: string };
    const ticket = new URL(redirectTo).searchParams.get('ticket')!;
    const crossed = await two.browser.get(`${h.issuer}/oauth/interaction/${two.uid}/finish?ticket=${ticket}`);
    expect(crossed.res.status).toBe(400);
  });

  it('asks again on every authorization: nothing is remembered between flows', async () => {
    await connect(h, client);
    const second = await startAuthorization(h, client);
    expect(second.uid).toBeTruthy();
  });
});

describe('dynamic client registration', () => {
  let h: OAuthHarness;
  beforeAll(async () => {
    h = await boot({ OAUTH_DCR_EXTRA_REDIRECT_URIS: 'https://agent.example.org/oauth/cb' });
  });

  it('accepts the allowlisted redirects and loopback callbacks', async () => {
    for (const redirect of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://www.cursor.com/agents/mcp/oauth/callback',
      'https://vscode.dev/redirect',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'http://localhost:8787/callback',
      'http://127.0.0.1:33418/',
      'https://agent.example.org/oauth/cb',
    ]) {
      const { res, json } = await registerClient(h, { redirect_uris: [redirect] });
      expect(res.status, redirect).toBe(201);
      expect(json.client_id).toBeTruthy();
      expect(json.registration_access_token).toBeUndefined();
    }
  });

  it('refuses anything outside the allowlist', async () => {
    for (const redirect of [
      'https://evil.test/callback',
      'https://claude.ai/api/mcp/auth_callback/../x',
      'https://claude.ai.evil.test/api/mcp/auth_callback',
      'http://localhost:8787/other',
      'http://evil.test:8787/callback',
      'http://user:pw@127.0.0.1:1/cb',
    ]) {
      const { res, json } = await registerClient(h, { redirect_uris: [redirect] });
      expect(res.status, redirect).toBe(400);
      expect(json.error).toBe('invalid_redirect_uri');
    }
  });

  it('refuses key-based client auth and strips fetchable URLs', async () => {
    const pk = await registerClient(h, { token_endpoint_auth_method: 'private_key_jwt', jwks_uri: 'https://evil.test/jwks' });
    expect(pk.res.status).toBe(400);
    const ok = await registerClient(h, { logo_uri: 'https://evil.test/logo.png' });
    expect(ok.res.status).toBe(201);
    expect(ok.json.logo_uri).toBeUndefined();
  });

  it('an unused registration expires; one somebody connected with lives as long as its grant', async () => {
    const unused = await publicClient(h);
    const used = await publicClient(h);
    await connect(h, used);
    const rows = await h.db.all<{ id: string; expires_at: number | string }>(
      sql`SELECT id, expires_at FROM oauth_record WHERE kind = 'Client' AND id IN (${unused.client_id}, ${used.client_id})`,
    );
    const exp = Object.fromEntries(rows.map((r) => [r.id, Number(r.expires_at)]));
    expect(exp[unused.client_id]! - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    expect(exp[used.client_id]! - Date.now()).toBeGreaterThan(89 * 86_400_000);
  });

  it('is rate limited per address', async () => {
    const limited = await boot({ RATE_LIMIT_ENABLED: 'true' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await registerClient(limited)).res.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('client ID metadata documents', () => {
  let h: OAuthHarness;
  const docs = new Map<string, unknown>();
  beforeAll(async () => {
    h = await boot();
    h.oauth.cimdAllowed = async () => true;
    h.oauth.fetchImpl = async (input) => {
      const url = String(input);
      const doc = docs.get(url);
      return doc === undefined ? new Response('not found', { status: 404 }) : Response.json(doc, { headers: { 'cache-control': 'max-age=60' } });
    };
  });

  it('connects a client by its metadata URL, and the consent page names the URL host', async () => {
    const id = 'https://agent.example/oauth/client.json';
    docs.set(id, { client_id: id, client_name: 'Agent Example', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    // Claude Code's shape: loopback without a port, used on an ephemeral one.
    const client = { client_id: id, redirect: 'http://localhost:40123/callback' };
    const started = await startAuthorization(h, client);
    const d = (await (await fetch(`${h.issuer}/v1/oauth/consent/${started.uid}`, { headers: h.owner })).json()) as ConsentDetails;
    expect(d.client).toMatchObject({ host: 'agent.example', via: 'cimd', name: 'Agent Example', loopback: true });
    const res = await decide(h, started.uid, 'approve');
    const back = await followDecision(started, ((await res.json()) as { redirectTo: string }).redirectTo);
    const t = await exchange(h, client, back.searchParams.get('code')!, started.pkce.verifier);
    expect(t.status).toBe(200);
    expect(t.json.refresh_token).toBeTruthy();
  });

  it('refuses a document whose client_id is not its own URL', async () => {
    const id = 'https://agent.example/mismatch.json';
    docs.set(id, { client_id: 'https://agent.example/someone-else.json', redirect_uris: ['https://agent.example/cb'], token_endpoint_auth_method: 'none' });
    const res = await new Browser(h.issuer).get(authorizeUrl(h, { client_id: id, redirect: 'https://agent.example/cb' }));
    expect(res.res.status).toBe(400);
    expect(res.location).toBeNull();
  });

  it('refuses a document with a shared-secret auth method, and a redirect the document does not list', async () => {
    const secret = 'https://agent.example/secret.json';
    docs.set(secret, { client_id: secret, redirect_uris: ['https://agent.example/cb'], token_endpoint_auth_method: 'client_secret_post' });
    expect((await new Browser(h.issuer).get(authorizeUrl(h, { client_id: secret, redirect: 'https://agent.example/cb' }))).res.status).toBe(400);
    const id = 'https://agent.example/fine.json';
    docs.set(id, { client_id: id, redirect_uris: ['https://agent.example/cb'], token_endpoint_auth_method: 'none' });
    expect((await new Browser(h.issuer).get(authorizeUrl(h, { client_id: id, redirect: 'https://agent.example/other' }))).res.status).toBe(400);
  });

  it('never fetches from a private, loopback or special address, nor an explicit port', async () => {
    const real = await boot();
    let fetched = 0;
    const realFetch = real.oauth.fetchImpl;
    real.oauth.fetchImpl = async (...args) => {
      fetched += 1;
      return realFetch(...args);
    };
    for (const id of [
      'https://127.0.0.1/client.json',
      'https://10.1.2.3/client.json',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/client.json',
      'https://localhost/client.json',
      'https://example.com:6379/client.json',
    ]) {
      const res = await new Browser(real.issuer).get(authorizeUrl(real, { client_id: id, redirect: 'https://x.test/cb' }));
      expect(res.res.status, id).toBe(400);
    }
    expect(fetched).toBe(0);
  });
});

describe('the MCP door with OAuth on', () => {
  let h: OAuthHarness;
  let client: Client;
  let reader: string;
  beforeAll(async () => {
    h = await boot();
    client = await publicClient(h);
    reader = (await connect(h, client)).access_token;
  });

  it('a protected tool with no credential is an HTTP 401 that points at the metadata and names the scopes', async () => {
    const res = await callTool(h, 'list_bookings', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${h.issuer}/.well-known/oauth-protected-resource/mcp", scope="${READ}"`,
    );
    const write = await callTool(h, 'create_booking', {});
    expect(write.headers.get('www-authenticate')).toContain(`scope="${READ} bookings:write"`);
    const byId = await callTool(h, 'find_available_slots', { event_type_id: 'x', time_zone: 'UTC' });
    expect(byId.status).toBe(401);
  });

  it('initialize, tools/list and the public tools still need nothing', async () => {
    const init = await h.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(init.status).toBe(200);
    const list = await h.post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const slots = await callTool(h, 'find_available_slots', { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', time_zone: 'UTC' });
    expect(slots.status).toBe(200);
    expect((await toolResult(slots)).isError).toBeFalsy();
  });

  it('an access token opens the door: the tools see the account, member and scopes', async () => {
    const res = await callTool(h, 'whoami', {}, reader);
    expect(res.status).toBe(200);
    const body = await toolResult<{ account: { code: string }; key: { scopes: string[]; prefix: string } }>(res);
    expect(body.structuredContent!.account.code).toBe('acme');
    expect(body.structuredContent!.key.scopes).toEqual(READ.split(' '));
    expect(body.structuredContent!.key.prefix).toMatch(/^oauth:/);
    const events = await toolResult(await callTool(h, 'list_event_types', {}, reader));
    expect(events.isError).toBeFalsy();
  });

  it('a missing scope is a 403 insufficient_scope listing everything the connection needs', async () => {
    const res = await callTool(h, 'create_booking', {}, reader);
    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate')!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain(`scope="${READ} bookings:write"`);
    expect(challenge).toContain(`resource_metadata="${h.issuer}/.well-known/oauth-protected-resource/mcp"`);
    const cancel = await callTool(h, 'cancel_booking', { booking_uid: 'x' }, reader);
    expect(cancel.headers.get('www-authenticate')).toContain(`scope="${READ} bookings:cancel"`);
  });

  it('after step-up the write works', async () => {
    const writer = (await connect(h, client, { scope: `${READ} bookings:write` })).access_token;
    const res = await callTool(h, 'create_booking', { event_type_id: 'nope', start: '2030-01-01T10:00:00Z', attendee: { name: 'A', email: 'a@x.test', time_zone: 'UTC' }, idempotency_key: 'k-1' }, writer);
    expect(res.status).toBe(200);
    const body = await toolResult(res);
    expect(body.content?.[0]?.text).not.toContain('INSUFFICIENT_SCOPE');
  });

  it('refuses a token for another audience, another issuer, another key, the wrong type, or past its expiry', async () => {
    const bad = [
      await forge(h, { aud: 'https://other.example/mcp' }),
      await forge(h, { iss: 'https://other-issuer.example' }),
      await forge(h, {}, { key: 'foreign' }),
      await forge(h, {}, { typ: 'JWT' }),
      await forge(h, { exp: Math.floor(Date.now() / 1000) - 60 }),
      'not-a-jwt',
    ];
    for (const token of bad) {
      const res = await callTool(h, 'whoami', {}, token);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    }
    // The forging itself is sound: the same claims with our key, audience and issuer pass.
    expect((await callTool(h, 'whoami', {}, await forge(h, {}))).status).toBe(200);
  });

  it("a token for one account sees nothing of another's", async () => {
    const get = await toolResult(await callTool(h, 'get_booking', { booking_uid: h.other.bookingUid }, reader));
    expect(get.isError).toBe(true);
    expect(get.content?.[0]?.text).toContain('NOT_FOUND');
    const list = await toolResult<{ bookings: { uid: string }[] }>(await callTool(h, 'list_bookings', {}, reader));
    expect(JSON.stringify(list.structuredContent)).not.toContain(h.other.bookingUid);
    // And the other tenant's owner connecting sees their own booking only.
    const started = await startAuthorization(h, client);
    const res = await decide(h, started.uid, 'approve', h.otherOwner);
    const back = await followDecision(started, ((await res.json()) as { redirectTo: string }).redirectTo);
    const theirs = (await exchange(h, client, back.searchParams.get('code')!, started.pkce.verifier)).json.access_token as string;
    const mine = await toolResult(await callTool(h, 'get_booking', { booking_uid: h.other.bookingUid }, theirs));
    expect(mine.isError).toBeFalsy();
  });

  it('dcl_ API keys work exactly as before, scope errors included', async () => {
    const key = await h.key(['event-types:read']);
    const ok = await toolResult(await callTool(h, 'list_event_types', {}, key));
    expect(ok.isError).toBeFalsy();
    const denied = await callTool(h, 'list_bookings', {}, key);
    expect(denied.status).toBe(200);
    expect((await toolResult(denied)).content?.[0]?.text).toContain('INSUFFICIENT_SCOPE');
    const wrongKey = await callTool(h, 'list_bookings', {}, 'dcl_00000000_nope');
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('writes the OAuth client into the audit line and never the token', async () => {
    h.audit.length = 0;
    await callTool(h, 'list_event_types', {}, reader);
    const line = JSON.parse(h.audit.at(-1)!) as Record<string, unknown>;
    expect(line.caller).toMatch(/^oauth:/);
    expect(line.client).toBe(client.client_id);
    expect(h.audit.join('\n')).not.toContain(reader.slice(-20));
  });
});

describe('refresh tokens and revocation', () => {
  let strict: OAuthHarness;
  let client: Client;
  beforeAll(async () => {
    strict = await boot({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: '0' });
    client = await publicClient(strict);
  });

  it('rotates on every use; reusing a spent token revokes the whole connection', async () => {
    const t0 = await connect(strict, client);
    const t1 = await refresh(strict, client, t0.refresh_token!);
    expect(t1.status).toBe(200);
    expect(t1.json.refresh_token).not.toBe(t0.refresh_token);
    expect((await callTool(strict, 'whoami', {}, String(t1.json.access_token))).status).toBe(200);
    const reuse = await refresh(strict, client, t0.refresh_token!);
    expect(reuse.status).toBe(400);
    expect(reuse.json.error).toBe('invalid_grant');
    // The live descendant died with the grant.
    const after = await refresh(strict, client, String(t1.json.refresh_token));
    expect(after.json.error).toBe('invalid_grant');
  });

  it('within the retry grace a spent token rotates again instead of revoking', async () => {
    const lenient = await boot({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: '30' });
    const c = await publicClient(lenient);
    const t0 = await connect(lenient, c);
    const a = await refresh(lenient, c, t0.refresh_token!);
    const b = await refresh(lenient, c, t0.refresh_token!);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await refresh(lenient, c, String(a.json.refresh_token))).status).toBe(200);
  });

  it('a refresh token never outlives the grant, and is stored hashed', async () => {
    const t0 = await connect(strict, client);
    const rows = await strict.db.all<{ id: string; payload: string; expires_at: number | string }>(
      sql`SELECT id, payload, expires_at FROM oauth_record WHERE kind = 'RefreshToken'`,
    );
    const hashed = createHash('sha256').update(t0.refresh_token!).digest('base64url');
    const row = rows.find((r) => r.id === hashed)!;
    expect(row).toBeTruthy();
    expect(rows.some((r) => r.id === t0.refresh_token || r.payload.includes(t0.refresh_token!))).toBe(false);
    const grantExp = Number(
      (await strict.db.get<{ expires_at: number | string }>(sql`SELECT expires_at FROM oauth_record WHERE kind = 'Grant' AND id = ${JSON.parse(row.payload).grantId}`))!.expires_at,
    );
    expect(Number(row.expires_at)).toBeLessThanOrEqual(grantExp + 1000);
  });

  it('Connected apps lists the grant; revoking it kills refresh at once (the access token lives to its expiry)', async () => {
    const t0 = await connect(strict, client);
    const list = (await (await fetch(`${strict.issuer}/v1/oauth/grants`, { headers: strict.owner })).json()) as {
      enabled: boolean;
      accessTokenTtlSeconds: number;
      grants: { id: string; clientName: string; clientHost: string; scopes: string[]; approvedBy: string }[];
    };
    expect(list.enabled).toBe(true);
    expect(list.accessTokenTtlSeconds).toBe(3600);
    const grantId = (JSON.parse(Buffer.from(t0.access_token.split('.')[1]!, 'base64url').toString()) as { grant_id: string }).grant_id;
    const mine = list.grants.find((g) => g.id === grantId)!;
    expect(mine).toMatchObject({ clientName: 'Spec Agent', clientHost: 'localhost:7777', scopes: READ.split(' ') });

    // Another account cannot see or revoke it.
    const theirs = (await (await fetch(`${strict.issuer}/v1/oauth/grants`, { headers: strict.otherOwner })).json()) as { grants: { id: string }[] };
    expect(theirs.grants.map((g) => g.id)).not.toContain(grantId);
    expect((await fetch(`${strict.issuer}/v1/oauth/grants/${grantId}`, { method: 'DELETE', headers: strict.otherOwner })).status).toBe(404);
    // A plain member cannot list or revoke.
    expect((await fetch(`${strict.issuer}/v1/oauth/grants`, { headers: strict.member })).status).toBe(403);

    expect((await fetch(`${strict.issuer}/v1/oauth/grants/${grantId}`, { method: 'DELETE', headers: strict.owner })).status).toBe(204);
    const after = await refresh(strict, client, t0.refresh_token!);
    expect(after.status).toBe(400);
    expect(after.json.error).toBe('invalid_grant');
    expect((await callTool(strict, 'whoami', {}, t0.access_token)).status).toBe(200);
    const gone = (await (await fetch(`${strict.issuer}/v1/oauth/grants`, { headers: strict.owner })).json()) as { grants: { id: string }[] };
    expect(gone.grants.map((g) => g.id)).not.toContain(grantId);
  });

  it('RFC 7009: revoking the refresh token at /oauth/revoke ends the connection too', async () => {
    const t0 = await connect(strict, client);
    const res = await fetch(`${strict.issuer}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t0.refresh_token!, token_type_hint: 'refresh_token', client_id: client.client_id }),
    });
    expect(res.status).toBe(200);
    expect((await refresh(strict, client, t0.refresh_token!)).json.error).toBe('invalid_grant');
  });

  it('a member demoted or disabled after approving can no longer refresh', async () => {
    const t0 = await connect(strict, client);
    await strict.db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${strict.ownerIds.memberId}`);
    try {
      expect((await refresh(strict, client, t0.refresh_token!)).json.error).toBe('invalid_grant');
    } finally {
      await strict.db.run(sql`UPDATE member SET status = 'active' WHERE id = ${strict.ownerIds.memberId}`);
    }
  });

  it('Connected apps answers enabled:false with OAuth off', async () => {
    const off = await bootHarness();
    open.push(off);
    const owner = (await off.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${off.accountId} AND role = 'owner' LIMIT 1`))!;
    const res = await fetch(`${off.base}/v1/oauth/grants`, { headers: { 'x-slate-account': off.accountId, 'x-slate-member': owner.id } });
    expect(await res.json()).toEqual({ enabled: false, accessTokenTtlSeconds: null, grants: [] });
  });
});
