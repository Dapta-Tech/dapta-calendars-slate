import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, listOutbox, migrate, seed, sql, type Db, type OutboxRow } from '@slate/db';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AnalyticsEffects } from '../analytics-effects';
import type { AnalyticsProvider } from '../analytics.provider';
import type { MachinePrincipal } from '../auth.service';
import {
  MCP_ANONYMOUS_DISTINCT_ID,
  MCP_TOOL_CALL_EVENT,
  McpUsageReporter,
  clientInfoOf,
  clientLabel,
  toolCallEvent,
  userAgentLabel,
  type McpToolCallEvent,
} from './mcp-usage';
import { ToolFailure, signInKey, type McpCall } from './support';

/**
 * MCP usage reporting: one `$mcp_tool_call` per tool call, enqueued under the
 * vendor's own event name (no `calendars_` prefix), about the member's email
 * when there is one, with nothing from the call's arguments, never the
 * caller's address, and nothing at all with analytics off.
 */

const ON = {
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: 'phc_test_key',
  PRODUCT_ANALYTICS_HOST: 'https://ingest.example.test',
  PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'jordan@',
};

function env(over: Partial<Record<string, string>> = {}): ServerEnv {
  return loadServerEnv({ NODE_ENV: 'test', PUBLIC_APP_URL: 'https://calendar.example.test', ...over } as NodeJS.ProcessEnv);
}

const provider: AnalyticsProvider = { name: 'recording', capture: async () => undefined, updateAccount: async () => undefined };

type Capture = { event: string; distinctId: string; accountKey: string | null; timestamp: number; properties: Record<string, unknown> };

let db: Db;
let accountId: string;
let alex: string;
let jordan: string;

const rows = async (): Promise<OutboxRow[]> => (await listOutbox(db, { kind: 'analytics' })) as OutboxRow[];
const captures = async (): Promise<Capture[]> =>
  (await rows()).map((r) => (JSON.parse(r.payload!) as { capture: Capture }).capture);

function event(overrides: Partial<McpToolCallEvent> = {}): McpToolCallEvent {
  return {
    tool: 'list_bookings',
    ok: true,
    errorCode: null,
    durationMs: 42,
    protocolVersion: '2025-06-18',
    client: { name: 'Claude', version: '1.2.3', userAgent: 'claude-code/2.1.0', vendor: 'anthropic' },
    credentialType: 'oauth',
    accountId,
    memberId: alex,
    keyPrefix: null,
    signInId: null,
    ...overrides,
  };
}

const KEYED = { credentialType: 'api_key', memberId: null, keyPrefix: 'dcl_1a2b3c4d' } as const;

const reporter = (fx: AnalyticsEffects | null, clock?: () => number) => new McpUsageReporter(fx, '1.0.0', clock);

beforeEach(async () => {
  db = await createDb('file::memory:');
  await migrate(db);
  await seed(db);
  accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
  alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
  jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`))!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe('AnalyticsEffects.captureRaw', () => {
  const input = { distinctId: 'a@b.test', accountId: null, accountKey: null, isInternal: false, properties: {} };

  it('keeps a $mcp_ name as given', async () => {
    await new AnalyticsEffects(db, provider, env(ON)).captureRaw('$mcp_tool_call', input);
    expect((await rows()).map((r) => r.action)).toEqual(['$mcp_tool_call']);
    expect((await captures())[0]!.event).toBe('$mcp_tool_call');
  });

  it('refuses any other name, so it cannot skip the prefix', async () => {
    const fx = new AnalyticsEffects(db, provider, env(ON));
    for (const name of ['booking_created', 'calendars_booking_created', '$pageview', '$mcp_Tool_Call', '$mcp_tool_call ', '$mcp_']) {
      await fx.captureRaw(name, input);
    }
    expect(await rows()).toEqual([]);
  });

  it('enqueues nothing with analytics off', async () => {
    await new AnalyticsEffects(db, null, env()).captureRaw('$mcp_tool_call', input);
    expect(await rows()).toEqual([]);
  });

  it('takes no place in the account order lane, which host events keep', async () => {
    const fx = new AnalyticsEffects(db, provider, env(ON));
    await fx.captureRaw('$mcp_tool_call', { ...input, accountId, accountKey: 'acme' });
    await fx.hostEvent('hours_set', { accountId, memberId: alex });
    const [raw, host] = await rows();
    expect(raw).toMatchObject({ action: '$mcp_tool_call', accountId, orderKey: null });
    expect(host).toMatchObject({ action: 'calendars_hours_set', accountId, orderKey: accountId });
  });
});

describe('McpUsageReporter', () => {
  let fx: AnalyticsEffects;
  beforeEach(() => {
    fx = new AnalyticsEffects(db, provider, env(ON));
  });

  it('enqueues one $mcp_tool_call in the MCP analytics vocabulary, about the member', async () => {
    await reporter(fx, () => 1_700_000_000_000).report(event());
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ action: MCP_TOOL_CALL_EVENT, accountId });
    const [c] = await captures();
    expect(c).toMatchObject({ event: '$mcp_tool_call', distinctId: 'alex@example.com', accountKey: 'acme', timestamp: 1_700_000_000_000 });
    expect(c!.properties).toEqual({
      $mcp_tool_name: 'list_bookings',
      $mcp_resource_name: 'list_bookings',
      $mcp_is_error: false,
      $mcp_duration_ms: 42,
      $mcp_protocol_version: '2025-06-18',
      $mcp_client_name: 'Claude',
      $mcp_client_version: '1.2.3',
      $mcp_client_user_agent: 'claude-code/2.1.0',
      $mcp_vendor_client: 'anthropic',
      $mcp_server_name: 'dCal',
      $mcp_server_version: '1.0.0',
      $mcp_source: 'posthog_mcp_analytics',
      credential_type: 'oauth',
      staff_access: false,
      product: 'calendars',
      is_internal: false,
      account_code: 'acme',
      $host: 'calendar.example.test',
    });
    // No account name ever travels.
    expect(JSON.stringify(c)).not.toContain('Acme');
  });

  it('reports a failure by its code as a label', async () => {
    const r = reporter(fx);
    await r.report(event({ ok: false, errorCode: 'NOT_FOUND' }));
    await r.report(event({ ok: false, errorCode: 'Bad Request' }));
    expect((await captures()).map((c) => [c.properties['$mcp_is_error'], c.properties['$mcp_error_type']])).toEqual([
      [true, 'not_found'],
      [true, 'other'],
    ]);
  });

  it('never reports a rate-limited call; other refusals before the tool runs are reported', async () => {
    const r = reporter(fx);
    await r.report(event({ ok: false, errorCode: 'RATE_LIMITED' }));
    for (const code of ['INSUFFICIENT_SCOPE', 'ACCOUNT_REQUIRED', 'NOT_LINKED']) await r.report(event({ ok: false, errorCode: code }));
    expect((await captures()).map((c) => c.properties['$mcp_error_type'])).toEqual(['insufficient_scope', 'account_required', 'not_linked']);
  });

  it('leaves out the client fields it was not given', async () => {
    await reporter(fx).report(event({ client: {} }));
    const [c] = await captures();
    for (const k of ['$mcp_client_name', '$mcp_client_version', '$mcp_client_user_agent', '$mcp_vendor_client', '$mcp_error_type']) {
      expect(c!.properties).not.toHaveProperty(k);
    }
  });

  it('flags the operator\'s own people as internal, under both names', async () => {
    await reporter(fx).report(event({ memberId: jordan }));
    const [c] = await captures();
    expect(c).toMatchObject({ distinctId: 'jordan@example.com' });
    expect(c!.properties).toMatchObject({ is_internal: true, staff_access: true });
  });

  it('drops a member with no email instead of inventing an id', async () => {
    await db.run(sql`UPDATE member SET email = NULL WHERE id = ${alex}`);
    await reporter(fx).report(event());
    expect(await rows()).toEqual([]);
  });

  it('files an API key under its public handle, grouped by the account, without a person profile', async () => {
    await reporter(fx).report(event(KEYED));
    const [row] = await rows();
    expect(row!.accountId).toBe(accountId);
    const [c] = await captures();
    expect(c).toMatchObject({ distinctId: 'dcl_1a2b3c4d', accountKey: 'acme' });
    expect(c!.properties).toMatchObject({
      credential_type: 'api_key',
      $process_person_profile: false,
      is_internal: false,
      staff_access: false,
      account_code: 'acme',
    });
  });

  it('an API key is internal when its account\'s oldest owner is', async () => {
    const own = new AnalyticsEffects(db, provider, env({ ...ON, PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'alex@' }));
    await reporter(own).report(event(KEYED));
    const [c] = await captures();
    expect(c!.properties).toMatchObject({ is_internal: true, staff_access: true });
  });

  it('sends a sign-in that reached no account under its hashed id, without a person profile or group', async () => {
    await reporter(fx).report(event({ tool: 'whoami', accountId: null, memberId: null, signInId: 'login:0123abcd' }));
    const [row] = await rows();
    expect(row!.accountId).toBeNull();
    const [c] = await captures();
    expect(c).toMatchObject({ distinctId: 'login:0123abcd', accountKey: null });
    expect(c!.properties).toMatchObject({ $process_person_profile: false, credential_type: 'oauth', is_internal: false, staff_access: false });
    expect(c!.properties).not.toHaveProperty('account_code');
  });

  it('sends an anonymous call under one constant id, without a person profile or group', async () => {
    await reporter(fx).report(event({ tool: 'find_available_slots', credentialType: 'none', accountId: null, memberId: null }));
    const [c] = await captures();
    expect(c).toMatchObject({ distinctId: MCP_ANONYMOUS_DISTINCT_ID, accountKey: null });
    expect(MCP_ANONYMOUS_DISTINCT_ID).toBe('dcal-mcp-anonymous');
    expect(c!.properties).toMatchObject({ $process_person_profile: false, credential_type: 'none', staff_access: false });
    expect(c!.properties).not.toHaveProperty('account_code');
  });

  it('reads an identity once for a few minutes, then again', async () => {
    let now = 1_000;
    const r = reporter(fx, () => now);
    const reads = vi.spyOn(db, 'get');
    await r.report(event());
    await db.run(sql`UPDATE member SET email = ${'new@example.com'} WHERE id = ${alex}`);
    await r.report(event());
    await r.report(event(KEYED));
    await r.report(event(KEYED));
    expect(reads).toHaveBeenCalledTimes(2);
    now += 6 * 60_000;
    await r.report(event());
    expect((await captures()).map((c) => c.distinctId)).toEqual([
      'alex@example.com',
      'alex@example.com',
      'dcl_1a2b3c4d',
      'dcl_1a2b3c4d',
      'new@example.com',
    ]);
  });

  it('concurrent misses share one read', async () => {
    const r = reporter(fx);
    const reads = vi.spyOn(db, 'get');
    await Promise.all([r.report(event()), r.report(event()), r.report(event())]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(3);
  });

  it('remembers a member with no email, but reads an unreadable one again', async () => {
    await db.run(sql`UPDATE member SET email = NULL WHERE id = ${alex}`);
    const r = reporter(fx);
    const reads = vi.spyOn(db, 'get');
    await r.report(event());
    await r.report(event());
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockClear();
    await r.report(event({ memberId: 'not-written-yet' }));
    await r.report(event({ memberId: 'not-written-yet' }));
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await rows()).toEqual([]);
  });

  it('with analytics off reads nothing and enqueues nothing', async () => {
    const reads = vi.spyOn(db, 'get');
    await reporter(new AnalyticsEffects(db, null, env())).report(event());
    await reporter(null).report(event());
    expect(reads).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('never rejects when the database throws, and caches nothing from the failure', async () => {
    const r = reporter(fx);
    vi.spyOn(db, 'get').mockRejectedValueOnce(new Error('db down'));
    await expect(r.report(event())).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
    await r.report(event());
    expect((await captures()).map((c) => c.distinctId)).toEqual(['alex@example.com']);
  });

  it('never rejects when analytics fails', async () => {
    const broken = {
      enabled: true,
      memberIdentity: fx.memberIdentity.bind(fx),
      captureRaw: () => Promise.reject(new Error('vendor down')),
    } as unknown as AnalyticsEffects;
    await expect(reporter(broken).report(event())).resolves.toBeUndefined();
  });
});

describe('toolCallEvent', () => {
  const base: McpCall = {
    requestId: 'req-1',
    protocolVersion: '2025-06-18',
    ip: '203.0.113.9',
    principal: null,
    client: { name: 'Claude', userAgent: 'claude-code/2.1.0', vendor: 'anthropic' },
  };
  const key: MachinePrincipal = {
    keyId: 'k1',
    prefix: 'dcl_1a2b3c4d',
    accountId: 'acct-1',
    scopes: [],
    eventTypeIds: null,
    expiresAtMs: null,
  };
  const login = { token: { subject: 'user_01HSUBJECT', expiresAtMs: 0 }, accounts: [] };

  it('an API key acts in its account as no member', () => {
    expect(toolCallEvent('list_bookings', { ...base, principal: key }, undefined, 7)).toEqual({
      tool: 'list_bookings',
      ok: true,
      errorCode: null,
      durationMs: 7,
      protocolVersion: '2025-06-18',
      client: { name: 'Claude', userAgent: 'claude-code/2.1.0', vendor: 'anthropic' },
      credentialType: 'api_key',
      accountId: 'acct-1',
      memberId: null,
      keyPrefix: 'dcl_1a2b3c4d',
      signInId: null,
    });
  });

  it('an OAuth connection or a sign-in in an account acts as its member', () => {
    const e = toolCallEvent('get_booking', { ...base, principal: { ...key, kind: 'oauth', prefix: 'login:abcd1234', memberId: 'm1' } }, undefined, 1);
    expect(e).toMatchObject({ credentialType: 'oauth', accountId: 'acct-1', memberId: 'm1', keyPrefix: null, signInId: null });
  });

  it('a sign-in that acted in no account is its hashed id, never the raw subject; no credential is nobody', () => {
    const e = toolCallEvent('whoami', { ...base, login }, undefined, 1);
    expect(e).toMatchObject({ credentialType: 'oauth', accountId: null, memberId: null, signInId: signInKey(login) });
    expect(e.signInId).toMatch(/^login:[0-9a-f]{32}$/);
    expect(JSON.stringify(e)).not.toContain('user_01HSUBJECT');
    expect(toolCallEvent('find_available_slots', base, undefined, 1)).toMatchObject({
      credentialType: 'none',
      accountId: null,
      memberId: null,
      keyPrefix: null,
      signInId: null,
    });
  });

  it('carries the failure code only, never the message, and never the address', () => {
    const e = toolCallEvent('cancel_booking', { ...base, principal: key }, new ToolFailure('NOT_FOUND', 'Booking secret-uid not found.'), 3);
    expect(e).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    const json = JSON.stringify(e);
    expect(json).not.toContain('secret-uid');
    expect(json).not.toContain('203.0.113.9');
  });
});

describe('client text', () => {
  const req = (headers: Record<string, string | string[]>, body: unknown = {}) => ({ headers, body });

  it('reads clientInfo from initialize, or the per-request _meta envelope', () => {
    expect(clientInfoOf(req({}, { method: 'initialize', params: { clientInfo: { name: 'Claude', version: '1.2.3' } } }))).toEqual({
      name: 'Claude',
      version: '1.2.3',
    });
    expect(
      clientInfoOf(req({}, { method: 'tools/call', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'Cursor', version: '2.0' } } } })),
    ).toEqual({ name: 'Cursor', version: '2.0' });
  });

  it('sends a client name or version as given only when it is a plain label', () => {
    for (const plain of ['Claude Code', '@modelcontextprotocol/inspector', 'claude-ai (web)', '2.1.0+build:7']) expect(clientLabel(plain)).toBe(plain);
    for (const odd of ['ada@example.com', 'https://evil.test/x', 'x'.repeat(65), '<script>', 'Ada\u200BBot', '\u00f1and\u00fa', ['phc', 'abcdefghijkl'].join('_')]) {
      expect(clientLabel(odd), odd).toBe('other');
    }
    // Addresses and URLs without a scheme, which pass the character list.
    for (const odd of ['203.0.113.9', '2001:db8::1', 'example.com:8443/reset', 'example.com/reset', '120.0.6099.10000000']) {
      expect(clientLabel(odd), odd).toBe('other');
    }
    for (const plain of ['1.2.3', 'Node.js', 'mcp-remote 0.1.29']) expect(clientLabel(plain)).toBe(plain);
    expect(clientLabel('  ')).toBeUndefined();
    expect(clientLabel(42)).toBeUndefined();
    expect(clientInfoOf(req({}, { params: { clientInfo: { name: 'bob@example.com', version: 7 } } }))).toEqual({ name: 'other' });
  });

  it('cleans a user agent: no invisible characters, URLs, addresses or tokens, at most 200 characters', () => {
    expect(userAgentLabel('claude-code/2.1.0 (external, cli)')).toBe('claude-code/2.1.0 (external, cli)');
    expect(userAgentLabel('Mozilla/5.0 Chrome/120.0.6099.109 Safari/537.36')).toBe('Mozilla/5.0 Chrome/120.0.6099.109 Safari/537.36');
    expect(userAgentLabel('bot/1 (+https://bot.example.test/about?who=me; ada\u200B@example.com)')).toBe('bot/1 (+[url]; [email])');
    // Built at run time, so secret scanners do not read the test input as a key.
    const fakeKey = ['dcl', 'abcdef123456'].join('_');
    expect(userAgentLabel(`agent/1\u202E\u0007 ${fakeKey}`)).toBe('agent/1 [token]');
    expect(userAgentLabel('agent/1 (203.0.113.9; example.com:8443/reset/secret)')).toBe('agent/1 ([ip]; [url])');
    expect(userAgentLabel('agent/1 2001:db8::1 ::1 www.example.com/reset?code=1')).toBe('agent/1 [ip] [ip] [url]');
    expect(userAgentLabel('agent/1 https%3A%2F%2Fexample.com%2Freset')).toBe('agent/1 [url]');
    expect(userAgentLabel('Node.js/22.15.0 undici/6.21 bot.example.test')).toBe('Node.js/22.15.0 undici/6.21 bot.example.test');
    expect(userAgentLabel(`agent/1 ${'x'.repeat(400)}`)).toHaveLength(200);
    expect(userAgentLabel('\u200B')).toBeUndefined();
  });

  it('names the vendor from a header or the user agent', () => {
    expect(clientInfoOf(req({ 'x-anthropic-client': 'claude-ai' })).vendor).toBe('anthropic');
    expect(clientInfoOf(req({ 'user-agent': 'claude-code/2.1.0' })).vendor).toBe('anthropic');
    expect(clientInfoOf(req({ 'user-agent': 'Anthropic/ClaudeAI' })).vendor).toBe('anthropic');
    expect(clientInfoOf(req({ 'openai-conversation-id': 'c1' })).vendor).toBe('openai');
    expect(clientInfoOf(req({ 'user-agent': 'openai-mcp/1.0' })).vendor).toBe('openai');
    expect(clientInfoOf(req({ 'user-agent': 'Cursor/1.0' })).vendor).toBeUndefined();
  });

  it('is empty when the request says nothing', () => {
    expect(clientInfoOf(req({}, undefined))).toEqual({});
    expect(clientInfoOf(req({}, [{ params: { clientInfo: { name: 'batched' } } }]))).toEqual({});
  });
});
