import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createApiKey, sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from '../mcp/mcp-harness';
import { NOT_LINKED_MESSAGE } from '../mcp/mcp.controller';
import { startFakeAs, type FakeAs } from './fake-as';

/**
 * The MCP endpoint as a resource server for an external authorization server,
 * end to end over HTTP on the whole AppModule: discovery, the 401 challenge,
 * token checks, the person-to-member mapping (403 when there is none), one and
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

/** Record a subject on a member the way a web login does (the latest login wins within the account). */
async function link(h: Harness, member: string, subject: string) {
  const row = (await h.db.get<{ account_id: string }>(sql`SELECT account_id FROM member WHERE id = ${member}`))!;
  await h.db.run(sql`UPDATE member SET idp_subject = NULL WHERE account_id = ${row.account_id} AND idp_subject = ${subject}`);
  await h.db.run(sql`UPDATE member SET idp_subject = ${subject} WHERE id = ${member}`);
}

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

  it('a valid sign-in that is not linked, not an admin, or disabled gets 403 with the plain message (no challenge)', async () => {
    const member = await addMember(h, 'member');
    await link(h, member, 'user_plain_member');
    const disabled = await addMember(h, 'admin', 'disabled');
    await link(h, disabled, 'user_disabled_admin');
    const invited = await addMember(h, 'admin', 'active');
    await h.db.run(sql`UPDATE member SET status = 'invited' WHERE id = ${invited}`);
    await link(h, invited, 'user_invited_admin');
    for (const subject of ['user_nobody', 'user_plain_member', 'user_disabled_admin', 'user_invited_admin']) {
      const res = await rpc(h, 'tools/list', {}, await as.mint({ sub: subject }));
      expect(res.status).toBe(403);
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect((await body(res)).error!.message).toBe(NOT_LINKED_MESSAGE);
    }
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
    expect((await rpc(h, 'tools/list', {}, token)).status).toBe(200);
    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${id}`);
    expect((await rpc(h, 'tools/list', {}, token)).status).toBe(403);
    await h.db.run(sql`UPDATE member SET role = 'admin' WHERE id = ${id}`);
    expect((await rpc(h, 'tools/list', {}, token)).status).toBe(200);
    await h.db.run(sql`DELETE FROM member WHERE id = ${id}`);
    expect((await rpc(h, 'tools/list', {}, token)).status).toBe(403);
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
