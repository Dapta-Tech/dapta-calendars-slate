import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createApiKey, sql } from '@slate/db';
import { AnalyticsEffects } from '../analytics-effects';
import { bootHarness, errorText, idem, structured, type Harness } from '../mcp/mcp-harness';
import { startFakeAs, type FakeAs } from './fake-as';
import { TOOLS, accessOf } from '../mcp/tools';
import type { McpCall } from '../mcp/support';

/**
 * The MCP endpoint as a resource server for an external authorization server,
 * end to end over HTTP on the whole AppModule: discovery, the 401 challenge,
 * token checks, the person-to-member mapping (a connection that acts nowhere
 * when there is none), one and
 * several accounts, and the built-in server staying dormant even with its
 * issuer and key still configured (the dev rollout state).
 */

const RESOURCE = 'https://calendar.example.test/mcp';
const PRM_URL = 'https://calendar.example.test/.well-known/oauth-protected-resource/mcp';
const ALL_SCOPES = ['event-types:read', 'availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel'];
const signingJwk = () => JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));

const fakes: FakeAs[] = [];
const harnesses: Harness[] = [];
async function setup(env: Parameters<typeof bootHarness>[0] = {}) {
  const as = await startFakeAs({ audience: RESOURCE });
  const h = await bootHarness({
    OAUTH_ENABLED: 'true',
    OAUTH_AUTHORIZATION_SERVER: as.issuer,
    MCP_PUBLIC_URL: RESOURCE,
    // What dev still carries from the built-in server: present, and ignored.
    OAUTH_ISSUER: 'https://calendar.example.test',
    OAUTH_SIGNING_JWK: signingJwk(),
    ...env,
  });
  fakes.push(as);
  harnesses.push(h);
  return { as, h };
}
afterAll(async () => {
  await Promise.all(harnesses.map((h) => h.close()));
  await Promise.all(fakes.map((as) => as.close()));
});

const rpc = (h: Harness, method: string, params: unknown, token?: string, headers: Record<string, string> = {}) =>
  h.post({ jsonrpc: '2.0', id: 1, method, params }, { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers });

/** The JSON-RPC body of a response, JSON or a one-event SSE stream. */
async function body(res: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await res.text();
  return text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
}

async function tool(h: Harness, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(h, 'tools/call', { name, arguments: args }, token);
  expect(res.status).toBe(200);
  return (await body(res)).result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
}

const memberId = async (h: Harness, handle: string) =>
  (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = ${handle} LIMIT 1`))!.id;

/** Record a subject on a member the way a web login does (the latest login wins within the account; the login counts as seen). */
async function link(h: Harness, member: string, subject: string) {
  const row = (await h.db.get<{ account_id: string }>(sql`SELECT account_id FROM member WHERE id = ${member}`))!;
  await h.db.run(sql`UPDATE member SET idp_subject = NULL WHERE account_id = ${row.account_id} AND idp_subject = ${subject}`);
  await h.db.run(sql`UPDATE member SET idp_subject = ${subject}, login_seen_at = ${Date.now()} WHERE id = ${member}`);
}

const DAY = 86_400_000;
/** What every non-public tool answers a sign-in that reaches no account (the harness serves PUBLIC_APP_URL). */
const NOT_LINKED =
  'NOT_LINKED: This sign-in is not an owner or admin of any account on this server yet. Ask the user to open https://calendar.example.test on the web once with this account (signing in again if it is already open), then try again; a member who is not an admin asks an owner for the admin role. There is no need to reconnect.';
const seenAt = (h: Harness, member: string, at: number | null) => h.db.run(sql`UPDATE member SET login_seen_at = ${at} WHERE id = ${member}`);

/** A dashboard request as this member: what a web login does, through the local auth stub. */
const openWebApp = async (h: Harness, accountId: string, member: string) =>
  (await fetch(`${h.base}/v1/oauth/grants`, { headers: { 'x-slate-account': accountId, 'x-slate-member': member } })).status;

/** A new member of the seeded account, with its own subject. */
async function addMember(h: Harness, role: 'owner' | 'admin' | 'member', status: 'active' | 'disabled' = 'active') {
  const id = randomUUID();
  await h.db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, role, status, created_at)
        VALUES (${id}, ${h.accountId}, ${`m-${id.slice(0, 6)}`}, 'Extra', ${`${id.slice(0, 6)}@example.test`}, 'UTC', ${role}, ${status}, ${Date.now()})`,
  );
  return id;
}

async function slot(h: Harness, token: string, eventTypeId: string, nth: number, accountId?: string) {
  const r = structured<{ days: { slots: { start: string }[] }[] }>(
    await tool(h, token, 'find_available_slots', { event_type_id: eventTypeId, time_zone: 'UTC', ...(accountId ? { account_id: accountId } : {}) }),
  );
  return r.days.flatMap((d) => d.slots)[nth]!.start;
}

describe('discovery', () => {
  let as: FakeAs;
  let h: Harness;
  beforeAll(async () => {
    ({ as, h } = await setup());
  });

  it('protected-resource metadata names the external server on both paths, whatever the Host', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${h.base}${path}`, { headers: { host: 'attacker.test', 'x-forwarded-host': 'attacker.test' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [as.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: [],
        resource_name: 'Dapta Calendars',
      });
    }
  });

  it('serves the external server metadata to clients that read it from this origin, without forwarding their headers', async () => {
    const res = await fetch(`${h.base}/.well-known/oauth-authorization-server`, { headers: { authorization: 'Bearer secret', cookie: 'a=b' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.issuer).toBe(as.issuer);
    expect(m.jwks_uri).toBe(as.jwksUrl);
    expect(m.registration_endpoint).toBe(`${as.issuer}/oauth2/register`);
  });

  it('the built-in server is not mounted, even with its issuer and key still set', async () => {
    for (const path of ['/oauth/jwks', '/oauth/authorize?client_id=x', '/oauth/interaction/abc']) expect((await fetch(`${h.base}${path}`)).status).toBe(404);
    const reg = await fetch(`${h.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(reg.status).toBe(404);
  });

  it('the consent API answers 404 with its own code, and Connected apps says external with nothing listed', async () => {
    const owner = { 'x-slate-account': h.accountId, 'x-slate-member': await memberId(h, 'alex-rivera') };
    const consent = await fetch(`${h.base}/v1/oauth/consent/abc`, { headers: owner });
    expect(consent.status).toBe(404);
    expect(((await consent.json()) as { error: string }).error).toBe('EXTERNAL_AUTHORIZATION_SERVER');
    const decide = await fetch(`${h.base}/v1/oauth/consent/abc`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: '{"decision":"approve"}' });
    expect(decide.status).toBe(404);
    const grants = await fetch(`${h.base}/v1/oauth/grants`, { headers: owner });
    expect(await grants.json()).toEqual({ enabled: false, external: true, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
    // The mode decides before the session: signed out, and with no request at all, the same 404.
    const signedOut = await setup({ AUTH_LOCAL_STRICT: 'true' });
    for (const [method, path] of [['GET', '/v1/oauth/consent/abc'], ['POST', '/v1/oauth/consent/abc'], ['GET', '/v1/oauth/consent']] as const) {
      const res = await fetch(`${signedOut.h.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('EXTERNAL_AUTHORIZATION_SERVER');
    }
  });

  it('answers 503, never 500, while the external metadata cannot be fetched', async () => {
    const down = await setup();
    down.as.modes.metadata = 'error';
    const res = await fetch(`${down.h.base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { error: string }).error).toBe('UNAVAILABLE');
  });
});

describe('the door', () => {
  let as: FakeAs;
  let h: Harness;
  let alex: string;
  beforeAll(async () => {
    ({ as, h } = await setup());
    alex = await memberId(h, 'alex-rivera');
    await link(h, alex, 'user_alex');
  });

  it('a protected tool with no token gets 401 with resource_metadata and no scope; public tools and the handshake still work', async () => {
    const res = await rpc(h, 'tools/call', { name: 'list_bookings', arguments: {} }, undefined, { host: 'attacker.test' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PRM_URL}"`);
    const whoami = await rpc(h, 'tools/call', { name: 'whoami', arguments: {} });
    expect(whoami.status).toBe(401);
    const byId = await rpc(h, 'tools/call', { name: 'find_available_slots', arguments: { event_type_id: 'x', time_zone: 'UTC' } });
    expect(byId.status).toBe(401);
    expect((await rpc(h, 'tools/list', {})).status).toBe(200);
    const page = await rpc(h, 'tools/call', { name: 'find_available_slots', arguments: { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', time_zone: 'UTC' } });
    expect(page.status).toBe(200);
  });

  it('a bad token is 401 invalid_token with the same resource_metadata, never 500', async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      'garbage',
      await as.mint({ sub: 'user_alex', iss: 'https://evil.example.test' }),
      await as.mint({ sub: 'user_alex', aud: 'https://other.example.test/mcp' }),
      await as.mint({ sub: 'user_alex', exp: now - 120 }),
    ];
    for (const token of bad) {
      const res = await rpc(h, 'tools/list', {}, token);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", resource_metadata="${PRM_URL}", error_description="The access token is invalid or expired."`,
      );
    }
    // A key outage is a 401 too.
    const outage = await setup();
    outage.as.modes.jwks = 'error';
    const res = await rpc(outage.h, 'tools/list', {}, await outage.as.mint({ sub: 'user_alex' }));
    expect(res.status).toBe(401);
    // A wrong API key keeps its own answer.
    const key = await rpc(h, 'tools/list', {}, 'dcl_nope');
    expect(key.status).toBe(401);
    expect(key.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  it('a valid sign-in that is not linked, not an admin, or disabled connects, acts nowhere, and every tool says to open the app (no challenge)', async () => {
    const before = h.audit.length;
    const member = await addMember(h, 'member');
    await link(h, member, 'user_plain_member');
    const disabled = await addMember(h, 'admin', 'disabled');
    await link(h, disabled, 'user_disabled_admin');
    const invited = await addMember(h, 'admin', 'active');
    await h.db.run(sql`UPDATE member SET status = 'invited' WHERE id = ${invited}`);
    await link(h, invited, 'user_invited_admin');
    for (const subject of ['user_nobody', 'user_plain_member', 'user_disabled_admin', 'user_invited_admin']) {
      const token = await as.mint({ sub: subject });
      // The chat app's connect succeeds, so it shows the tools' words, never its own failed-login error.
      const res = await rpc(h, 'tools/list', {}, token);
      expect(res.status).toBe(200);
      expect(res.headers.get('www-authenticate')).toBeNull();
      for (const [name, args] of [
        ['whoami', {}],
        ['list_my_accounts', {}],
        ['list_event_types', {}],
        ['list_event_types', { account_id: h.accountId }],
        ['list_event_types', { account_id: h.other.accountId }],
        ['list_bookings', {}],
      ] as const) {
        expect(errorText(await tool(h, token, name, args)), `${subject} ${name}`).toBe(NOT_LINKED);
      }
    }
    // What is public on a booking page still works, as for an anonymous call.
    const nobody = await as.mint({ sub: 'user_nobody' });
    const page = { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', time_zone: 'UTC' };
    expect((await tool(h, nobody, 'find_available_slots', page)).isError).toBeFalsy();
    // Nothing it called left an account behind on the audit line.
    const lines = h.audit.slice(before).map((l) => JSON.parse(l) as { tool: string; accountId: string | null; error?: string });
    expect(lines.length).toBe(25);
    expect(lines.filter((l) => l.tool !== 'find_available_slots').every((l) => l.accountId === null && l.error === 'NOT_LINKED')).toBe(true);
  });

  it('one account: tools, whoami, list_my_accounts, list_event_types and a booking, acting as the member with every MCP scope', async () => {
    const token = await as.mint({ sub: 'user_alex', client_id: 'https://client.example.test/meta', sid: 'session_9' });
    const client = await h.connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_my_accounts');
    const who = structured<{ account: { code: string }; key: { prefix: string; scopes: string[]; event_type_allowlist: null; expires_at: string } }>(
      await client.callTool({ name: 'whoami', arguments: {} }),
    );
    expect(who.account.code).toBe('acme');
    expect(who.key.prefix).toBe(`login:${alex.slice(0, 8)}`);
    expect(who.key.scopes).toEqual(ALL_SCOPES);
    expect(who.key.event_type_allowlist).toBeNull();
    expect(Date.parse(who.key.expires_at)).toBeGreaterThan(Date.now());
    const accounts = structured<{ accounts: { id: string; name: string }[] }>(await client.callTool({ name: 'list_my_accounts', arguments: {} }));
    expect(accounts.accounts).toEqual([{ id: h.accountId, name: 'Acme Inc.' }]);
    // Naming its own account is fine; naming another one is not found.
    const own = structured<{ event_types: { id: string; slug: string }[] }>(await client.callTool({ name: 'list_event_types', arguments: { account_id: h.accountId } }));
    const intro = own.event_types.find((e) => e.slug === 'intro-call')!;
    expect(errorText(await client.callTool({ name: 'list_event_types', arguments: { account_id: h.other.accountId } }))).toMatch(/^NOT_FOUND/);

    const start = await slot(h, token, intro.id, 2);
    const created = structured<{ booking: { uid: string; status: string } }>(
      await client.callTool({
        name: 'create_booking',
        arguments: {
          event_type_id: intro.id,
          start,
          attendee: { name: 'Login Invitee', email: 'login@example.org', time_zone: 'UTC' },
          answers: { company: 'Login Co' },
          idempotency_key: idem('login-create-0001'),
        },
      }),
    );
    expect(created.booking.status).toBe('accepted');
    const line = h.audit.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.tool === 'create_booking')!;
    expect(line).toMatchObject({ caller: `login:${alex.slice(0, 8)}`, accountId: h.accountId, client: 'https://client.example.test/meta', sid: 'session_9', result: 'ok' });
    expect(h.audit.join('\n')).not.toContain(token);
  });

  it('removing the admin role, or the member, cuts access on the very next request', async () => {
    const id = await addMember(h, 'admin');
    await link(h, id, 'user_revocable');
    const token = await as.mint({ sub: 'user_revocable' });
    const acts = async () => !(await tool(h, token, 'list_event_types')).isError;
    expect(await acts()).toBe(true);
    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${id}`);
    expect(errorText(await tool(h, token, 'list_event_types'))).toBe(NOT_LINKED);
    await h.db.run(sql`UPDATE member SET role = 'admin' WHERE id = ${id}`);
    expect(await acts()).toBe(true);
    await h.db.run(sql`DELETE FROM member WHERE id = ${id}`);
    expect(errorText(await tool(h, token, 'list_event_types'))).toBe(NOT_LINKED);
  });
});

describe('how long a link holds, and the accounts reached by switching', () => {
  it('a stale link answers like no link; opening the web app once makes it fresh again', async () => {
    const { as, h } = await setup();
    const id = await addMember(h, 'admin');
    await link(h, id, 'user_stale');
    const token = await as.mint({ sub: 'user_stale' });
    expect((await tool(h, token, 'list_event_types')).isError).toBeFalsy();
    await seenAt(h, id, Date.now() - 31 * DAY);
    expect(errorText(await tool(h, token, 'list_event_types'))).toBe(NOT_LINKED);
    // Never stamped at all: the same.
    await seenAt(h, id, null);
    expect(errorText(await tool(h, token, 'list_event_types'))).toBe(NOT_LINKED);
    // A verified dashboard request stamps the member again, and the same token acts on its next call.
    expect(await openWebApp(h, h.accountId, id)).toBe(200);
    expect((await tool(h, token, 'list_event_types')).isError).toBeFalsy();
  });

  it('OAUTH_LINK_MAX_AGE_DAYS sets the window', async () => {
    const { as, h } = await setup({ OAUTH_LINK_MAX_AGE_DAYS: '1' });
    const id = await addMember(h, 'admin');
    await link(h, id, 'user_short');
    await seenAt(h, id, Date.now() - 2 * DAY);
    expect(errorText(await tool(h, await as.mint({ sub: 'user_short' }), 'list_event_types'))).toBe(NOT_LINKED);
    await seenAt(h, id, Date.now() - DAY / 2);
    expect((await rpc(h, 'tools/list', {}, await as.mint({ sub: 'user_short' }))).status).toBe(200);
  });

  it("an admin of an account reached by switching (whose session carried no subject) signs in through the first account's link, while seen there", async () => {
    const { as, h } = await setup();
    const alex = await memberId(h, 'alex-rivera');
    const bo = await memberId(h, 'bo');
    // The same upstream user in both accounts; only the first account's login carried the subject.
    await h.db.run(sql`UPDATE member SET external_id = 'iam_alex' WHERE id IN (${alex}, ${bo})`);
    await link(h, alex, 'user_switcher');
    expect(await openWebApp(h, h.other.accountId, bo)).toBe(200);
    const token = await as.mint({ sub: 'user_switcher' });
    const accounts = structured<{ accounts: { id: string }[] }>(await tool(h, token, 'list_my_accounts'));
    expect(accounts.accounts.map((a) => a.id).sort()).toEqual([h.accountId, h.other.accountId].sort());
    const there = structured<{ account: { code: string }; key: { prefix: string } }>(await tool(h, token, 'whoami', { account_id: h.other.accountId }));
    expect(there.account.code).toBe('globex');
    expect(there.key.prefix).toBe(`login:${bo.slice(0, 8)}`);
    // Not seen in the second account within the window: it drops out, the first stays.
    await seenAt(h, bo, Date.now() - 31 * DAY);
    const left = structured<{ accounts: { id: string }[] }>(await tool(h, token, 'list_my_accounts'));
    expect(left.accounts.map((a) => a.id)).toEqual([h.accountId]);
    // A different upstream user in the second account is never reached.
    await h.db.run(sql`UPDATE member SET external_id = 'iam_someone_else' WHERE id = ${bo}`);
    await seenAt(h, bo, Date.now());
    expect(structured<{ accounts: { id: string }[] }>(await tool(h, token, 'list_my_accounts')).accounts.map((a) => a.id)).toEqual([h.accountId]);
  });
});

describe('several accounts', () => {
  let as: FakeAs;
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    ({ as, h } = await setup());
    await link(h, await memberId(h, 'alex-rivera'), 'user_multi');
    await link(h, await memberId(h, 'bo'), 'user_multi');
    token = await as.mint({ sub: 'user_multi' });
  });

  it('lists both accounts, and a call that needs one must name it', async () => {
    const accounts = structured<{ accounts: { id: string; name: string }[] }>(await tool(h, token, 'list_my_accounts'));
    expect(accounts.accounts.map((a) => a.name).sort()).toEqual(['Acme Inc.', 'Globex']);
    const missing = await tool(h, token, 'list_event_types');
    expect(missing.isError).toBe(true);
    expect(missing.content![0]!.text).toMatch(/^ACCOUNT_REQUIRED/);
    expect(missing.content![0]!.text).toContain(`Acme Inc. (${h.accountId})`);
    expect(missing.content![0]!.text).toContain(`Globex (${h.other.accountId})`);
    expect((await tool(h, token, 'whoami')).content![0]!.text).toMatch(/^ACCOUNT_REQUIRED/);
  });

  it('acts in the account it names, as that account\'s member', async () => {
    const globex = structured<{ event_types: { id: string }[] }>(await tool(h, token, 'list_event_types', { account_id: h.other.accountId }));
    expect(globex.event_types.map((e) => e.id)).toEqual([h.other.eventTypeId]);
    const acme = structured<{ account: { code: string } }>(await tool(h, token, 'whoami', { account_id: h.accountId }));
    expect(acme.account.code).toBe('acme');
    const got = structured<{ booking: { uid: string } }>(await tool(h, token, 'get_booking', { booking_uid: h.other.bookingUid, account_id: h.other.accountId }));
    expect(got.booking.uid).toBe(h.other.bookingUid);
    // The same booking from the other account is not there.
    expect((await tool(h, token, 'get_booking', { booking_uid: h.other.bookingUid, account_id: h.accountId })).content![0]!.text).toMatch(/^NOT_FOUND/);
  });

  it('an account it cannot reach is not found; a public booking page needs no account', async () => {
    const stranger = randomUUID();
    expect((await tool(h, token, 'list_event_types', { account_id: stranger })).content![0]!.text).toMatch(/^NOT_FOUND/);
    const page = await tool(h, token, 'find_available_slots', { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', time_zone: 'UTC' });
    expect(page.isError).toBeFalsy();
    // By id, the account must be named.
    expect((await tool(h, token, 'find_available_slots', { event_type_id: h.other.eventTypeId, time_zone: 'UTC' })).content![0]!.text).toMatch(/^ACCOUNT_REQUIRED/);
    const named = await tool(h, token, 'find_available_slots', { event_type_id: h.other.eventTypeId, time_zone: 'UTC', account_id: h.other.accountId });
    expect(named.isError).toBeFalsy();
  });

  it('an API key may name only its own account', async () => {
    const key = (await createApiKey(h.db, { accountId: h.accountId, name: 'spec', scopes: ALL_SCOPES })).plaintext;
    expect(structured<{ accounts: { id: string }[] }>(await tool(h, key, 'list_my_accounts')).accounts.map((a) => a.id)).toEqual([h.accountId]);
    expect((await tool(h, key, 'list_event_types', { account_id: h.accountId })).isError).toBeFalsy();
    expect((await tool(h, key, 'list_event_types', { account_id: h.other.accountId })).content![0]!.text).toMatch(/^NOT_FOUND/);
    expect((await tool(h, key, 'get_booking', { booking_uid: h.other.bookingUid, account_id: h.other.accountId })).content![0]!.text).toMatch(/^NOT_FOUND/);
  });
});

describe('the hold, pending-request and team tools with several accounts', () => {
  let as: FakeAs;
  let h: Harness;
  let token: string;
  let teamId: string;
  const ACME_PAGE = 'https://x.test/acme/alex-rivera/intro-call';
  const GLOBEX_PAGE = 'https://x.test/globex/bo/chat';
  const TEAM = 'https://x.test/acme/team/sales/team-demo';
  const invitee = (name: string) => ({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.org`, time_zone: 'UTC' });
  const text = (r: { content?: { text: string }[] }) => r.content![0]!.text;
  const starts = async (args: Record<string, unknown>, name = 'find_available_slots') =>
    structured<{ days: { slots: { start: string }[] }[] }>(await tool(h, token, name, { time_zone: 'UTC', ...args }))
      .days.flatMap((d) => d.slots)
      .map((s) => s.start);
  beforeAll(async () => {
    ({ as, h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '200', MCP_WRITE_RATE_LIMIT_CAPACITY: '200' }));
    await link(h, await memberId(h, 'alex-rivera'), 'user_more');
    await link(h, await memberId(h, 'bo'), 'user_more');
    token = await as.mint({ sub: 'user_more' });
    teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} AND slug = 'team-demo'`))!.id;
    // Globex's event waits for its host, so a booking there arrives as a request.
    await h.db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE id = ${h.other.eventTypeId}`);
  });

  it('by id or account-wide each must name an account, and one it cannot reach (or the wrong one of its own) is not found', async () => {
    const start = '2031-01-06T15:00:00Z';
    const calls: [string, Record<string, unknown>][] = [
      ['list_pending_bookings', {}],
      ['confirm_booking', { booking_uid: h.other.bookingUid, idempotency_key: idem('more-confirm-0001') }],
      ['decline_booking', { booking_uid: h.other.bookingUid, idempotency_key: idem('more-decline-0001') }],
      ['hold_slot', { event_type_id: h.other.eventTypeId, start, time_zone: 'UTC', idempotency_key: idem('more-hold-00001') }],
      ['find_team_slots', { event_type_id: teamId, time_zone: 'UTC' }],
      ['book_team_meeting', { event_type_id: teamId, start, attendee: invitee('Team Unnamed'), idempotency_key: idem('more-team-00001') }],
    ];
    for (const [name, args] of calls) {
      expect(text(await tool(h, token, name, args)), name).toMatch(/^ACCOUNT_REQUIRED/);
      expect(text(await tool(h, token, name, { ...args, account_id: randomUUID() })), name).toMatch(/^NOT_FOUND/);
    }
    expect(text(await tool(h, token, 'decline_booking', { booking_uid: h.other.bookingUid, idempotency_key: idem('more-decline-0002'), account_id: h.accountId }))).toMatch(/^NOT_FOUND/);
    expect(text(await tool(h, token, 'find_team_slots', { event_type_id: teamId, time_zone: 'UTC', account_id: h.other.accountId }))).toMatch(/^NOT_FOUND/);
    // An API key may name only its own account here too.
    const key = (await createApiKey(h.db, { accountId: h.accountId, name: 'spec', scopes: ALL_SCOPES })).plaintext;
    expect((await tool(h, key, 'list_pending_bookings', { account_id: h.accountId })).isError).toBeFalsy();
    expect(text(await tool(h, key, 'list_pending_bookings', { account_id: h.other.accountId }))).toMatch(/^NOT_FOUND/);
  });

  it('pending requests are listed, confirmed and declined in the account named, as its member', async () => {
    // Requested on Globex's public page, which needs no account.
    const open = await starts({ booking_page_url: GLOBEX_PAGE });
    const request = async (start: string, name: string, key: string) =>
      structured<{ booking: { uid: string; status: string } }>(
        await tool(h, token, 'book_meeting', { booking_page_url: GLOBEX_PAGE, start, attendee: invitee(name), idempotency_key: idem(key) }),
      ).booking;
    const first = await request(open[0]!, 'Rae Request', 'more-request-001');
    const second = await request(open[2]!, 'Dee Request', 'more-request-002');
    expect([first.status, second.status]).toEqual(['pending', 'pending']);

    const listed = structured<{ bookings: { uid: string }[] }>(await tool(h, token, 'list_pending_bookings', { account_id: h.other.accountId }));
    expect(listed.bookings.map((b) => b.uid).sort()).toEqual([first.uid, second.uid].sort());
    const acme = structured<{ bookings: { uid: string }[] }>(await tool(h, token, 'list_pending_bookings', { account_id: h.accountId }));
    expect(acme.bookings.map((b) => b.uid)).not.toContain(first.uid);

    type Decision = { booking: { uid: string; status: string }; already_applied: boolean };
    const confirm = { booking_uid: first.uid, idempotency_key: idem('more-confirm-0002'), account_id: h.other.accountId };
    expect(structured<Decision>(await tool(h, token, 'confirm_booking', confirm))).toMatchObject({ already_applied: false, booking: { status: 'accepted' } });
    // The same key in the same account replays; the decision is not made twice.
    expect(structured<Decision>(await tool(h, token, 'confirm_booking', confirm)).already_applied).toBe(true);
    const declined = structured<Decision>(
      await tool(h, token, 'decline_booking', { booking_uid: second.uid, reason: 'Full', idempotency_key: idem('more-decline-0003'), account_id: h.other.accountId }),
    );
    expect(declined).toMatchObject({ already_applied: false, booking: { status: 'rejected' } });
    const line = h.audit.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.tool === 'decline_booking' && l.result === 'ok')!;
    expect(line).toMatchObject({ caller: `login:${(await memberId(h, 'bo')).slice(0, 8)}`, accountId: h.other.accountId });
  });

  it('a hold made while naming an account is still booked by book_meeting, which names none; by id it is booked in that account only', async () => {
    const page = await starts({ booking_page_url: ACME_PAGE });
    const held = structured<{ hold: { hold_id: string } }>(
      await tool(h, token, 'hold_slot', { booking_page_url: ACME_PAGE, start: page[5]!, time_zone: 'UTC', idempotency_key: idem('more-hold-00002'), account_id: h.accountId }),
    );
    const booked = structured<{ booking: { status: string; start_utc: string } }>(
      await tool(h, token, 'book_meeting', {
        booking_page_url: ACME_PAGE,
        start: page[5]!,
        attendee: invitee('Hal Held'),
        answers: { company: 'Co' },
        hold_id: held.hold.hold_id,
        idempotency_key: idem('more-book-00001'),
      }),
    );
    expect(booked.booking.status).toBe('accepted');
    expect(booked.booking.start_utc).toBe(new Date(page[5]!).toISOString());

    const start = (await starts({ event_type_id: h.other.eventTypeId, account_id: h.other.accountId }))[4]!;
    const byId = structured<{ hold: { hold_id: string } }>(
      await tool(h, token, 'hold_slot', { event_type_id: h.other.eventTypeId, start, time_zone: 'UTC', idempotency_key: idem('more-hold-00003'), account_id: h.other.accountId }),
    );
    const create = (credential: string, key: string, accountId?: string) =>
      tool(h, credential, 'create_booking', {
        event_type_id: h.other.eventTypeId,
        start,
        attendee: invitee('Ida Id'),
        hold_id: byId.hold.hold_id,
        idempotency_key: idem(key),
        ...(accountId ? { account_id: accountId } : {}),
      });
    // A key of that same account did not make the hold, so it has no such hold.
    expect(text(await create(await h.otherKey(ALL_SCOPES), 'more-create-0001'))).toMatch(/^HOLD_NOT_FOUND/);
    const made = structured<{ booking: { uid: string; status: string } }>(await create(token, 'more-create-0002', h.other.accountId));
    expect(made.booking.status).toBe('pending');
  });

  it('a public-page booking retried without the account_id it first named replays: one booking, one analytics channel', async () => {
    const created = vi.spyOn(AnalyticsEffects.prototype, 'bookingCreated');
    try {
      const start = (await starts({ booking_page_url: TEAM }, 'find_team_slots'))[36]!;
      const args = { booking_page_url: TEAM, start, attendee: invitee('Ray Retry'), idempotency_key: idem('more-team-retry-01') };
      const first = structured<{ booking: { uid: string } }>(await tool(h, token, 'book_team_meeting', { ...args, account_id: h.accountId }));
      // What a TIMEOUT tells the agent to do: the same key again, here without account_id.
      const again = structured<{ booking: { uid: string } }>(await tool(h, token, 'book_team_meeting', args));
      expect(again.booking.uid).toBe(first.booking.uid);
      // book_meeting on the same team page is the same action under the same record.
      const direct = structured<{ booking: { uid: string }; replayed: boolean }>(await tool(h, token, 'book_meeting', args));
      expect(direct).toMatchObject({ replayed: true, booking: { uid: first.booking.uid } });
      const n = await h.db.get<{ n: number | string }>(
        sql`SELECT COUNT(*) AS n FROM booking b JOIN booking_attendee ba ON ba.booking_id = b.id WHERE ba.email = 'ray.retry@example.org'`,
      );
      expect(Number(n!.n)).toBe(1);
      expect(created.mock.calls.map(([b]) => b.channel)).toEqual(['api']);
    } finally {
      created.mockRestore();
    }
  });

  it("a sign-in's hold is not usable by an anonymous call from the same address, nor by another person in the same account", async () => {
    const intro = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} AND slug = 'intro-call'`))!.id;
    const other = await addMember(h, 'admin');
    await link(h, other, 'user_more_second');
    const second = await as.mint({ sub: 'user_more_second' });
    const page = await starts({ booking_page_url: ACME_PAGE });
    const onPage = structured<{ hold: { hold_id: string } }>(
      await tool(h, token, 'hold_slot', { booking_page_url: ACME_PAGE, start: page[9]!, time_zone: 'UTC', idempotency_key: idem('more-hold-00004') }),
    );
    const bookPage = (credential: string | undefined, key: string) => {
      const args = { booking_page_url: ACME_PAGE, start: page[9]!, attendee: invitee('Nora Nothold'), answers: { company: 'Co' }, hold_id: onPage.hold.hold_id, idempotency_key: idem(key) };
      return credential ? tool(h, credential, 'book_meeting', args) : rpc(h, 'tools/call', { name: 'book_meeting', arguments: args }).then(async (r) => (await body(r)).result as { content?: { text: string }[] });
    };
    // Same machine, no credential: the anonymous door does not reach a sign-in's hold.
    expect(text(await bookPage(undefined, 'more-steal-00001'))).toMatch(/^HOLD_NOT_FOUND/);
    // Another person, admin of the same account: not theirs either.
    expect(text(await bookPage(second, 'more-steal-00002'))).toMatch(/^HOLD_NOT_FOUND/);
    const byId = await starts({ event_type_id: intro, account_id: h.accountId });
    const idHold = structured<{ hold: { hold_id: string } }>(
      await tool(h, token, 'hold_slot', { event_type_id: intro, start: byId[11]!, time_zone: 'UTC', idempotency_key: idem('more-hold-00005'), account_id: h.accountId }),
    );
    const stolen = await tool(h, second, 'create_booking', {
      event_type_id: intro,
      start: byId[11]!,
      attendee: invitee('Nate Nothold'),
      answers: { company: 'Co' },
      hold_id: idHold.hold.hold_id,
      idempotency_key: idem('more-steal-00003'),
    });
    expect(text(stolen)).toMatch(/^HOLD_NOT_FOUND/);
    // The person who made it still books it.
    expect(structured<{ booking: { status: string } }>(await bookPage(token, 'more-book-00002')).booking.status).toBe('accepted');
  });

  it('team tools: a public team page needs no account; by id the named account books and reports its host', async () => {
    const onPage = structured<{ team: { slug: string } }>(await tool(h, token, 'find_team_slots', { booking_page_url: TEAM, time_zone: 'UTC' }));
    expect(onPage.team.slug).toBe('sales');
    const open = await starts({ event_type_id: teamId, account_id: h.accountId }, 'find_team_slots');
    const booked = structured<{ booking: { status: string }; assigned_hosts: string[] }>(
      await tool(h, token, 'book_team_meeting', { event_type_id: teamId, start: open[30]!, attendee: invitee('Tim Team'), idempotency_key: idem('more-team-00002'), account_id: h.accountId }),
    );
    expect(booked.assigned_hosts).toHaveLength(1);
    const publicBooked = structured<{ booking: { status: string } }>(
      await tool(h, token, 'book_team_meeting', { booking_page_url: TEAM, start: open[32]!, attendee: invitee('Pat Public'), idempotency_key: idem('more-team-00003') }),
    );
    expect(publicBooked.booking.status).toBe('accepted');
  });
});

describe('namespaces per member', () => {
  it('rate limits count per member, so one account running dry leaves the other untouched', async () => {
    const { as, h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '2', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.001' });
    await link(h, await memberId(h, 'alex-rivera'), 'user_rl');
    await link(h, await memberId(h, 'bo'), 'user_rl');
    const token = await as.mint({ sub: 'user_rl' });
    for (let i = 0; i < 2; i += 1) expect((await tool(h, token, 'whoami', { account_id: h.accountId })).isError).toBeFalsy();
    expect((await tool(h, token, 'whoami', { account_id: h.accountId })).content![0]!.text).toMatch(/^RATE_LIMITED/);
    expect((await tool(h, token, 'whoami', { account_id: h.other.accountId })).isError).toBeFalsy();
  });

  it('a sign-in reaching several accounts keeps its own bucket and namespace on public calls, never the address\'s', async () => {
    const { as, h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '2', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.001' });
    await link(h, await memberId(h, 'alex-rivera'), 'user_pub');
    await link(h, await memberId(h, 'bo'), 'user_pub');
    const token = await as.mint({ sub: 'user_pub' });
    const PAGE = 'https://x.test/acme/alex-rivera/intro-call';
    const anon = async (name: string, args: Record<string, unknown>) =>
      (await body(await rpc(h, 'tools/call', { name, arguments: args }))).result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
    // Anonymous calls from this address use up the address's read bucket...
    for (let i = 0; i < 2; i += 1) expect((await anon('find_available_slots', { booking_page_url: PAGE, time_zone: 'UTC' })).isError).toBeFalsy();
    expect((await anon('find_available_slots', { booking_page_url: PAGE, time_zone: 'UTC' })).content![0]!.text).toMatch(/^RATE_LIMITED/);
    // ...which the sign-in, from the same address, does not share.
    const slots = structured<{ days: { slots: { start: string }[] }[] }>(await tool(h, token, 'find_available_slots', { booking_page_url: PAGE, time_zone: 'UTC' }));
    const starts = slots.days.flatMap((d) => d.slots).map((x) => x.start);

    // The same idempotency key, anonymous and signed in, with different arguments: two bookings.
    const book = (start: string, email: string) => ({
      booking_page_url: PAGE,
      start,
      attendee: { name: 'Public', email, time_zone: 'UTC' },
      answers: { company: 'Co' },
      idempotency_key: idem('public-shared-0001'),
    });
    const anonBooked = await anon('book_meeting', book(starts[1]!, 'anon@example.org'));
    expect(anonBooked.isError).toBeFalsy();
    const signedIn = await tool(h, token, 'book_meeting', book(starts[3]!, 'signed@example.org'));
    expect(signedIn.isError).toBeFalsy();
    expect(signedIn.structuredContent!.replayed).toBe(false);
  });

  it('a refused account choice still uses up the caller\'s rate limit', async () => {
    const { as, h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '2', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.001' });
    await link(h, await memberId(h, 'alex-rivera'), 'user_refused');
    await link(h, await memberId(h, 'bo'), 'user_refused');
    const token = await as.mint({ sub: 'user_refused' });
    for (let i = 0; i < 2; i += 1) expect((await tool(h, token, 'whoami')).content![0]!.text).toMatch(/^ACCOUNT_REQUIRED/);
    expect((await tool(h, token, 'whoami')).content![0]!.text).toMatch(/^RATE_LIMITED/);
  });

  it('idempotency keys are per member: a key and a sign-in, or two sign-ins, never replay each other', async () => {
    const { as, h } = await setup();
    const alex = await memberId(h, 'alex-rivera');
    await link(h, alex, 'user_idem_a');
    const casey = await addMember(h, 'admin');
    await link(h, casey, 'user_idem_b');
    const a = await as.mint({ sub: 'user_idem_a' });
    const b = await as.mint({ sub: 'user_idem_b' });
    const key = (await createApiKey(h.db, { accountId: h.accountId, name: 'spec', scopes: ALL_SCOPES })).plaintext;
    const intro = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} AND slug = 'intro-call'`))!.id;
    const starts = await Promise.all([4, 6, 8].map((nth) => slot(h, a, intro, nth)));
    const book = (token: string, start: string, email: string) =>
      tool(h, token, 'create_booking', {
        event_type_id: intro,
        start,
        attendee: { name: 'Same Key', email, time_zone: 'UTC' },
        answers: { company: 'Co' },
        idempotency_key: idem('shared-key-00001'),
      });
    // Each caller books with the same key and its own arguments: had any of them
    // shared a namespace, the second and third would be IDEMPOTENCY_KEY_REUSED.
    const first = structured<{ booking: { uid: string } }>(await book(a, starts[0]!, 'one@example.org'));
    const second = structured<{ booking: { uid: string } }>(await book(b, starts[1]!, 'two@example.org'));
    const third = structured<{ booking: { uid: string } }>(await book(key, starts[2]!, 'three@example.org'));
    expect(new Set([first.booking.uid, second.booking.uid, third.booking.uid]).size).toBe(3);
    // The same member replaying its own key gets its own booking back.
    const replay = structured<{ booking: { uid: string } }>(await book(a, starts[0]!, 'one@example.org'));
    expect(replay.booking.uid).toBe(first.booking.uid);
    // ...and reusing it with other arguments is refused in its own namespace only.
    expect((await book(a, starts[1]!, 'one@example.org')).content![0]!.text).toMatch(/^IDEMPOTENCY_KEY_REUSED/);
  });
});

describe('a sign-in that reaches no account, tool by tool', () => {
  it('answers NOT_LINKED from every tool that is not public, whatever it names, before the tool runs', async () => {
    // Every call here comes from one address, whose budget this sign-in pays: room for them all.
    const { h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '1000', MCP_WRITE_RATE_LIMIT_CAPACITY: '1000' });
    const call: McpCall = {
      requestId: 'spec',
      protocolVersion: '2025-11-25',
      ip: '203.0.113.9',
      principal: null,
      login: { token: { subject: 'user_no_account', expiresAtMs: Date.now() + 600_000 }, accounts: [] },
    };
    const eventTypeId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE account_id = ${h.accountId} LIMIT 1`))!.id;
    const before = await h.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM booking`);
    let checked = 0;
    const names = new Set<string>();
    for (const def of TOOLS) {
      for (const args of [{}, { event_type_id: eventTypeId }, { account_id: h.accountId }, { account_id: h.other.accountId, event_type_id: eventTypeId }]) {
        if (accessOf(def, args) === 'public') continue;
        const result = await h.gateway.execute(def, args, call);
        expect(result.isError, `${def.name} ${JSON.stringify(args)}`).toBe(true);
        expect(result.content[0]!.text, `${def.name} ${JSON.stringify(args)}`).toBe(NOT_LINKED);
        checked += 1;
        names.add(def.name);
      }
    }
    // Every tool but book_meeting (public by design: its hold_id is the capability) is checked, most with every shape.
    expect([...names].sort()).toEqual(TOOLS.map((d) => d.name).filter((n) => n !== 'book_meeting').sort());
    expect(checked).toBeGreaterThan(TOOLS.length * 2);
    expect(await h.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM booking`)).toEqual(before);
  });

  it('pays a door budget per person: two tokens of one person share it, another person and a linked sign-in do not', async () => {
    const { as, h } = await setup({ RATE_LIMIT_CAPACITY: '3', RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    await link(h, await memberId(h, 'alex-rivera'), 'user_alex');
    const first = await as.mint({ sub: 'user_budget_nobody' });
    const second = await as.mint({ sub: 'user_budget_nobody', sid: 'another-session' });
    const codes: number[] = [];
    for (const token of [first, second, first, second, first]) codes.push((await rpc(h, 'tools/list', {}, token)).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
    // Someone else from the same address, unlinked or linked, still connects.
    expect((await rpc(h, 'tools/list', {}, await as.mint({ sub: 'user_budget_other' }))).status).toBe(200);
    expect((await rpc(h, 'tools/list', {}, await as.mint({ sub: 'user_alex' }))).status).toBe(200);
  });

  it("counts its public tool calls against the address, like an anonymous caller's", async () => {
    const { as, h } = await setup({ MCP_RATE_LIMIT_CAPACITY: '1', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    const page = { booking_page_url: 'https://x.test/acme/alex-rivera/intro-call', time_zone: 'UTC' };
    const anonymous = (await body(await rpc(h, 'tools/call', { name: 'find_available_slots', arguments: page }))).result as { isError?: boolean };
    expect(anonymous.isError).toBeFalsy();
    expect(errorText(await tool(h, await as.mint({ sub: 'user_shares_address' }), 'find_available_slots', page))).toMatch(/^RATE_LIMITED/);
  });

  it("keeps a hold it makes on a booking page the person's: nobody else books it, the same person does once linked", async () => {
    const { as, h } = await setup();
    const page = 'https://x.test/acme/alex-rivera/intro-call';
    const token = await as.mint({ sub: 'user_hold_later_linked' });
    const slots = structured<{ days: { slots: { start: string }[] }[] }>(await tool(h, token, 'find_available_slots', { booking_page_url: page, time_zone: 'UTC' }));
    const start = slots.days.flatMap((d) => d.slots)[3]!.start;
    const held = structured<{ hold: { hold_id: string } }>(
      await tool(h, token, 'hold_slot', { booking_page_url: page, start, time_zone: 'UTC', idempotency_key: idem('unlinked-hold-0001') }),
    );
    const attendee = { name: 'Later Linked', email: 'later@example.org', time_zone: 'UTC' };
    const book = (tok: string | undefined, key: string) =>
      rpc(h, 'tools/call', { name: 'book_meeting', arguments: { booking_page_url: page, start, attendee, answers: { company: 'L' }, hold_id: held.hold.hold_id, idempotency_key: idem(key) } }, tok);
    const anonymous = (await body(await book(undefined, 'unlinked-hold-0002'))).result as { isError?: boolean; content?: { text: string }[] };
    expect(anonymous.isError).toBe(true);
    expect(anonymous.content![0]!.text).toMatch(/^HOLD_NOT_FOUND/);
    const stranger = (await body(await book(await as.mint({ sub: 'user_someone_else' }), 'unlinked-hold-0003'))).result as { isError?: boolean; content?: { text: string }[] };
    expect(stranger.content![0]!.text).toMatch(/^HOLD_NOT_FOUND/);
    // The person opens the web app and becomes an admin linked to Acme: the same token books its own hold.
    const member = await addMember(h, 'admin');
    await link(h, member, 'user_hold_later_linked');
    const booked = (await body(await book(token, 'unlinked-hold-0004'))).result as { isError?: boolean; structuredContent?: { booking: { status: string } } };
    expect(booked.isError).toBeFalsy();
    expect(booked.structuredContent!.booking.status).toBe('accepted');
  });
});
