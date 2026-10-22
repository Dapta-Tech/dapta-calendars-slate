import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@slate/db';
import { loadServerEnv } from '@slate/config/env';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';
import { hostnameOf } from './mcp.controller';
import { BookingService } from '../booking.service';
import { argsHash, instantFrom, redactArgs, toFailure, untrusted, zonedIso, ToolFailure } from './support';

const PAGE = 'https://x.test/acme/alex-rivera/intro-call';
const initialize = (version: string) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

const open: Harness[] = [];
async function boot(env: Parameters<typeof bootHarness>[0] = {}) {
  const h = await bootHarness(env);
  open.push(h);
  return h;
}
afterAll(async () => {
  await Promise.all(open.map((h) => h.close()));
});

describe('transport guards', () => {
  it('refuses a browser Origin that is not allowlisted, allows listed ones and clients without one', async () => {
    const h = await boot({ MCP_ALLOWED_ORIGINS: 'https://inspector.example.test/' });
    const evil = await h.post(initialize('2025-06-18'), { origin: 'https://evil.test' });
    expect(evil.status).toBe(403);
    expect((await h.post(initialize('2025-06-18'), { origin: 'null' })).status).toBe(403);
    expect((await h.post(initialize('2025-06-18'), { origin: 'https://inspector.example.test' })).status).toBe(200);
    expect((await h.post(initialize('2025-06-18'))).status).toBe(200);
  });

  it('with nothing configured every browser origin is refused', async () => {
    const h = await boot();
    expect((await h.post(initialize('2025-06-18'), { origin: 'http://localhost:3000' })).status).toBe(403);
  });

  it('checks Host only when MCP_ALLOWED_HOSTS is set', async () => {
    const open_ = await boot();
    expect((await open_.post(initialize('2025-06-18'), { host: 'attacker.test' })).status).toBe(200);
    const strict = await boot({ MCP_ALLOWED_HOSTS: 'calendar-api.example.test' });
    const res = await fetch(strict.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: 'attacker.test' },
      body: JSON.stringify(initialize('2025-06-18')),
    });
    expect(res.status).toBe(403);
    expect(hostnameOf('Calendar-API.example.test:4000')).toBe('calendar-api.example.test');
    expect(hostnameOf('[::1]:4000')).toBe('[::1]');
  });

  it('refuses credentials in the URL', async () => {
    const h = await boot();
    for (const p of ['api_key', 'access_token', 'key']) {
      const res = await h.post(initialize('2025-06-18'), {}, `/mcp?${p}=dcl_abc`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('Authorization header');
    }
  });

  it('answers 405 to GET and DELETE, 415 to a non-JSON body, 413 to an oversized body', async () => {
    const h = await boot();
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(h.url, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    const text = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect(text.status).toBe(415);
    const big = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200_000) }),
    });
    expect(big.status).toBe(413);
  });

  it('is a 404 when MCP_ENABLED=false', async () => {
    const h = await boot({ MCP_ENABLED: 'false' });
    expect((await h.post(initialize('2025-06-18'))).status).toBe(404);
  });
});

describe('credentials', () => {
  it('answers 401 for an unknown, malformed, expired or revoked key instead of downgrading to anonymous', async () => {
    const h = await boot();
    const bad = await h.post(initialize('2025-06-18'), { authorization: 'Bearer dcl_00000000_nope' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('Bearer');
    expect((await h.post(initialize('2025-06-18'), { authorization: 'Bearer sk-not-ours' })).status).toBe(401);
    expect((await h.post(initialize('2025-06-18'), { authorization: 'Basic abc' })).status).toBe(401);
    const expired = await h.key(['bookings:read'], { expiresAtMs: Date.now() - 1000 });
    expect((await h.post(initialize('2025-06-18'), { authorization: `Bearer ${expired}` })).status).toBe(401);
    const live = await h.key(['bookings:read']);
    expect((await h.post(initialize('2025-06-18'), { authorization: `Bearer ${live}` })).status).toBe(200);
    await h.db.run(sql`UPDATE api_key SET revoked_at_ms = ${Date.now()} WHERE key_hash IS NOT NULL AND prefix = ${live.slice(0, 12)}`);
    expect((await h.post(initialize('2025-06-18'), { authorization: `Bearer ${live}` })).status).toBe(401);
  });

  it('does not read x-api-key: only the Authorization header opens the door', async () => {
    const h = await boot();
    const key = await h.key(['bookings:read']);
    const c = await h.connect(undefined, { 'x-api-key': key });
    expect(errorText(await c.callTool({ name: 'list_bookings', arguments: {} }))).toContain('AUTH_REQUIRED');
  });
});

describe('protocol eras', () => {
  it('serves a legacy initialize handshake (2025-06-18 and 2025-11-25) statelessly', async () => {
    const h = await boot();
    for (const version of ['2025-06-18', '2025-11-25']) {
      const res = await h.post(initialize(version));
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      const text = await res.text();
      expect(text).toContain('dapta-calendars');
      expect(text).toContain('"tools"');
    }
    const list = await h.post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('find_available_slots');
  });

  it('serves a 2026-07-28 request that carries the per-request envelope', async () => {
    const h = await boot();
    const res = await h.post(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
      },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('book_meeting');
    expect(text).toContain('resultType');
  });

  it('records the protocol version in the audit line', async () => {
    const h = await boot();
    const c = await h.connect();
    await c.callTool({ name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } });
    const line = JSON.parse(h.audit[0]!) as { protocolVersion: string };
    expect(line.protocolVersion).toMatch(/^20\d\d-\d\d-\d\d$/);
  });
});

describe('rate limits', () => {
  it('turns an exhausted per-key bucket into a clear tool error, per key not per process', async () => {
    const h = await boot({ MCP_RATE_LIMIT_CAPACITY: '2', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    const a = await h.connect(await h.key(['bookings:read']));
    const b = await h.connect(await h.key(['bookings:read']));
    for (let i = 0; i < 2; i += 1) structured(await a.callTool({ name: 'list_bookings', arguments: {} }));
    const text = errorText(await a.callTool({ name: 'list_bookings', arguments: {} }));
    expect(text).toContain('RATE_LIMITED');
    expect(text).toMatch(/Retry after \d+s/);
    structured(await b.callTool({ name: 'list_bookings', arguments: {} }));
  });

  it('gives write tools their own, tighter bucket', async () => {
    const h = await boot({ MCP_WRITE_RATE_LIMIT_CAPACITY: '1', MCP_WRITE_RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    const c = await h.connect(await h.key(['bookings:cancel', 'bookings:read']));
    const first = errorText(await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: 'missing' } }));
    expect(first).toContain('NOT_FOUND');
    expect(errorText(await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: 'missing' } }))).toContain('RATE_LIMITED');
    structured(await c.callTool({ name: 'list_bookings', arguments: {} }));
  });

  it('limits anonymous callers per address, on tool calls and on the door itself', async () => {
    const h = await boot({ MCP_RATE_LIMIT_CAPACITY: '1', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.01', RATE_LIMIT_CAPACITY: '12', RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    const c = await h.connect();
    structured(await c.callTool({ name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } }));
    expect(errorText(await c.callTool({ name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } }))).toContain('RATE_LIMITED');
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i += 1) last = (await h.post(initialize('2025-06-18'))).status;
    expect(last).toBe(429);
  });

  it('counts bad keys against the address so guessing is throttled', async () => {
    const h = await boot({ RATE_LIMIT_CAPACITY: '2', RATE_LIMIT_REFILL_PER_SEC: '0.01' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) codes.push((await h.post(initialize('2025-06-18'), { authorization: 'Bearer dcl_deadbeef_x' })).status);
    expect(codes).toContain(429);
    expect(codes[0]).toBe(401);
  });
});

describe('timeout', () => {
  it('abandons a slow call with a retry-safe message', async () => {
    const h = await boot({ MCP_TOOL_TIMEOUT_MS: '1000' });
    const slow = { name: 'slow', scope: null, write: false, run: () => new Promise(() => undefined) };
    const result = await h.gateway.execute(slow as never, {}, undefined);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('TIMEOUT');
    expect((result.content[0] as { text: string }).text).toContain('SAME idempotency_key');
  }, 10_000);
});

describe('REST cancel scope', () => {
  it('accepts bookings:cancel or bookings:write on /v2 and /v1/machine, and refuses neither-scope keys', async () => {
    const h = await boot();
    const mk = async (scopes: string[]) => h.key(scopes);
    const uidOf = () => h.newBooking();
    const v2 = (key: string, uid: string) =>
      fetch(`${h.base}/v2/bookings/${uid}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'cal-api-version': '2026-02-25', 'content-type': 'application/json' },
        body: '{}',
      });
    const v1 = (key: string, uid: string) =>
      fetch(`${h.base}/v1/machine/bookings/${uid}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
    const none = await mk(['bookings:read']);
    expect((await v2(none, await uidOf())).status).toBe(403);
    expect((await v1(none, await uidOf())).status).toBe(403);
    expect((await v2(await mk(['bookings:write']), await uidOf())).status).toBe(200);
    expect((await v1(await mk(['bookings:cancel']), await uidOf())).status).toBe(200);
    expect((await v2(await mk(['bookings:cancel']), await uidOf())).status).toBe(200);
  });

  it('lists keys with scopes, allowlist, expiry and last use', async () => {
    const h = await boot();
    const { listApiKeys } = await import('@slate/db');
    const key = await h.key(['bookings:read', 'bookings:cancel'], { eventTypeIds: ['et_1'], expiresAtMs: Date.now() + 86_400_000 });
    const before = (await listApiKeys(h.db, h.accountId)).find((k) => key.startsWith(k.prefix))!;
    expect(before).toMatchObject({ scopes: ['bookings:read', 'bookings:cancel'], eventTypeIds: ['et_1'], lastUsedAt: null });
    expect(before.expiresAt).toMatch(/^\d{4}-/);
    await h.post(initialize('2025-06-18'), { authorization: `Bearer ${key}` });
    const after = (await listApiKeys(h.db, h.accountId)).find((k) => key.startsWith(k.prefix))!;
    expect(after.lastUsedAt).toMatch(/^\d{4}-/);
  });
});

describe('REST machine attendee', () => {
  it('adds an attendee under the shared flow, queues the calendar update, once per address, and refuses a full, cancelled or foreign booking', async () => {
    const h = await boot();
    const key = await h.key(['bookings:write']);
    const rewrite = vi.spyOn(h.app.get(BookingService), 'afterGuestsChanged');
    const add = (uid: string, email = 'bo@example.com') =>
      fetch(`${h.base}/v1/machine/bookings/${uid}/attendees`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attendee: { name: 'Bo Added', email } }),
      });
    const uid = await h.newBooking();
    expect((await add(uid)).status).toBe(201);
    expect(rewrite.mock.calls).toEqual([[uid]]);
    expect((await h.db.get<{ seated: number | null }>(sql`SELECT seated FROM booking WHERE uid = ${uid}`))!.seated).toBe(1);
    // A retry writes nothing again and sends nothing again.
    expect((await add(uid, 'BO@example.com')).status).toBe(201);
    expect(rewrite.mock.calls).toEqual([[uid]]);
    // 30 people at most (this booking has no invitee row: Bo and 29 more): the 31st is refused.
    for (let i = 0; i < 29; i++) expect((await add(uid, `p${i}@example.com`)).status).toBe(201);
    const full = await add(uid, 'one-more@example.com');
    expect(full.status).toBe(422);
    expect(((await full.json()) as { error: string }).error).toBe('LIMIT_EXCEEDED');

    rewrite.mockClear();
    const gone = await h.newBooking();
    await h.db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${gone}`);
    expect((await add(gone)).status).toBe(410);
    expect((await add(h.other.bookingUid)).status).toBe(403);
    expect(rewrite).not.toHaveBeenCalled();
    const rows = await h.db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE email = 'bo@example.com' AND booking_id IN
            (SELECT id FROM booking WHERE uid IN (${gone}, ${h.other.bookingUid}))`,
    );
    expect(Number(rows!.n)).toBe(0);
  });
});

describe('config', () => {
  it('boots with nothing set and with blank deploy-rendered values', () => {
    const base = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(base.MCP_ENABLED).toBe(true);
    expect(base.MCP_PUBLIC_URL).toBeUndefined();
    expect(base.MCP_TOOL_TIMEOUT_MS).toBe(20_000);
    const blank = loadServerEnv({
      NODE_ENV: 'test',
      MCP_PUBLIC_URL: '',
      MCP_RATE_LIMIT_CAPACITY: '',
      MCP_TOOL_TIMEOUT_MS: '',
    } as NodeJS.ProcessEnv);
    expect(blank.MCP_PUBLIC_URL).toBeUndefined();
    expect(blank.MCP_RATE_LIMIT_CAPACITY).toBe(30);
  });
});

describe('support helpers', () => {
  it('cleans untrusted text', () => {
    expect(untrusted('hi​ <script>x</script> [a](http://e.test) ![i](http://e.test/p.png)\u0007 there')).toBe('hi x a there');
    expect(untrusted('x'.repeat(600), 100)).toHaveLength(100);
    expect(untrusted(null)).toBe('');
  });

  it('redacts personal fields from the audit hash but keeps the call shape', () => {
    const a = { tool: 'x', attendee: { name: 'A', email: 'a@b.co' }, idempotency_key: idem('k1'), event_type_id: 'e' };
    const b = { tool: 'x', attendee: { name: 'Z', email: 'z@b.co' }, idempotency_key: idem('k2'), event_type_id: 'e' };
    expect(argsHash(a)).toBe(argsHash(b));
    expect(JSON.stringify(redactArgs(a))).not.toContain('a@b.co');
    expect(argsHash({ ...a, event_type_id: 'other' })).not.toBe(argsHash(a));
  });

  it('reads a bare date as that local day and demands an offset otherwise', () => {
    expect(instantFrom('2026-11-03', 'America/Bogota').toISOString()).toBe('2026-11-03T05:00:00.000Z');
    expect(instantFrom('2026-11-03', 'America/Bogota', true).toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(instantFrom('2026-03-08', 'America/New_York', true).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(() => instantFrom('2026-02-31', 'UTC')).toThrow(ToolFailure);
    expect(() => instantFrom('2026-11-03T10:00:00', 'UTC')).toThrow(/offset/);
    expect(zonedIso(new Date('2026-11-03T15:00:00Z'), 'America/Bogota')).toBe('2026-11-03T10:00:00-05:00');
  });

  it('maps zod and http errors to codes a model can act on', () => {
    expect(toFailure(new Error('db exploded')).code).toBe('INTERNAL_ERROR');
    expect(toFailure(new Error('db exploded')).message).not.toContain('db exploded');
  });
});
