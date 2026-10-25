import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { listOutbox, sql, type OutboxRow } from '@slate/db';
import { startFakeAs, type FakeAs } from '../oauth/fake-as';
import { bootHarness, structured, type Harness } from './mcp-harness';
import { signInKey } from './support';

/**
 * Usage analytics through the real door: a tool call enqueues exactly one
 * `$mcp_tool_call`, and the protocol's own traffic (`initialize`,
 * `tools/list`) enqueues none. The worker is off in the harness, so the rows
 * stay in the outbox to be read.
 */
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const RESOURCE = 'https://calendar.example.test/mcp';
const ANALYTICS_ON = {
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: 'phc_test_key',
  PRODUCT_ANALYTICS_HOST: 'https://ingest.example.test',
  PRODUCT_ANALYTICS_ERRORS: 'off',
};

type Capture = { event: string; distinctId: string; accountKey: string | null; properties: Record<string, unknown> };

let h: Harness;

const usageRows = async (on: Harness = h): Promise<OutboxRow[]> =>
  ((await listOutbox(on.db, { kind: 'analytics' })) as OutboxRow[]).filter((r) => r.action === '$mcp_tool_call');
const captures = async (on: Harness = h): Promise<Capture[]> =>
  (await usageRows(on)).map((r) => (JSON.parse(r.payload!) as { capture: Capture }).capture);

/**
 * Reports are fire and forget, so a count read the moment the first row lands
 * would miss a wrong second one. Wait until the outbox has stopped growing
 * (unchanged across several reads), then read.
 */
async function settled(on: Harness = h): Promise<Capture[]> {
  let last = -1;
  let steady = 0;
  for (let i = 0; i < 100 && steady < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const n = (await usageRows(on)).length;
    steady = n === last ? steady + 1 : 0;
    last = n;
  }
  return captures(on);
}

beforeAll(async () => {
  h = await bootHarness(ANALYTICS_ON);
});
afterAll(async () => {
  await h.close();
});

describe('MCP usage analytics through the door', () => {
  it('initialize and tools/list enqueue nothing; one tool call enqueues exactly one $mcp_tool_call', async () => {
    const client = await h.connect(undefined, { 'user-agent': 'claude-code/2.1.0' });
    await client.listTools();
    expect(await settled()).toEqual([]);

    structured(await client.callTool({ name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } }));
    const [c, ...rest] = await settled();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ event: '$mcp_tool_call', distinctId: 'dcal-mcp-anonymous', accountKey: null });
    expect(c!.properties).toMatchObject({
      $mcp_tool_name: 'find_available_slots',
      $mcp_resource_name: 'find_available_slots',
      $mcp_is_error: false,
      $mcp_server_name: 'dCal',
      $mcp_source: 'posthog_mcp_analytics',
      $mcp_client_user_agent: 'claude-code/2.1.0',
      $mcp_vendor_client: 'anthropic',
      $process_person_profile: false,
      credential_type: 'none',
      product: 'calendars',
      $host: 'calendar.example.test',
    });
    expect(typeof c!.properties['$mcp_duration_ms']).toBe('number');
    // Never the arguments.
    expect(JSON.stringify(c)).not.toContain('intro-call');
  });

  it('a keyed call is filed under the key, in its account; a failed one carries its code', async () => {
    const before = (await usageRows()).length;
    const client = await h.connect(await h.key(['event-types:read']));
    structured(await client.callTool({ name: 'list_event_types', arguments: {} }));
    const failed = await client.callTool({ name: 'list_bookings', arguments: {} });
    expect(failed.isError).toBe(true);
    const fresh = (await settled()).slice(before);
    expect(fresh.map((c) => c.properties['$mcp_tool_name'])).toEqual(['list_event_types', 'list_bookings']);
    for (const c of fresh) {
      expect(c.distinctId).toMatch(/^dcl_[0-9a-f]{8}$/);
      expect(c).toMatchObject({ accountKey: 'acme' });
      expect(c.properties).toMatchObject({ credential_type: 'api_key', $process_person_profile: false, account_code: 'acme' });
    }
    expect(fresh[1]!.properties).toMatchObject({ $mcp_is_error: true, $mcp_error_type: 'insufficient_scope' });
  });

  it('a report that never settles, or throws at once, never holds up or breaks the tool result', async () => {
    const client = await h.connect();
    const args = { booking_page_url: PAGE, time_zone: 'UTC' };
    const report = vi.spyOn(h.gateway.usage, 'report').mockImplementation(() => new Promise<void>(() => undefined));
    try {
      structured(await client.callTool({ name: 'find_available_slots', arguments: args }));
      report.mockImplementation(() => {
        throw new Error('reporter exploded');
      });
      structured(await client.callTool({ name: 'find_available_slots', arguments: args }));
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    } finally {
      report.mockRestore();
    }
  });
});

describe('MCP usage analytics under a batch', () => {
  let small: Harness;
  beforeAll(async () => {
    small = await bootHarness({ ...ANALYTICS_ON, MCP_RATE_LIMIT_CAPACITY: '5', MCP_RATE_LIMIT_REFILL_PER_SEC: '0.001' });
  });
  afterAll(async () => {
    await small.close();
  });

  it('one POST carrying more calls than the limiter allows enqueues at most its capacity of events', async () => {
    const batch = Array.from({ length: 40 }, (_, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'tools/call',
      params: { name: 'find_available_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } },
    }));
    const res = await small.post(batch);
    expect(res.status).toBe(200);
    // Every call ran or was refused: 5 took a token, 35 were rate limited.
    expect((await res.text()).match(/RATE_LIMITED/g)?.length).toBe(35);
    const events = await settled(small);
    expect(events).toHaveLength(5);
    expect(events.every((c) => c.properties['$mcp_error_type'] !== 'rate_limited')).toBe(true);
  });
});

describe('MCP usage analytics for a sign-in through an external server', () => {
  let as: FakeAs;
  let ext: Harness;
  beforeAll(async () => {
    as = await startFakeAs({ audience: RESOURCE });
    ext = await bootHarness({
      ...ANALYTICS_ON,
      OAUTH_ENABLED: 'true',
      OAUTH_AUTHORIZATION_SERVER: as.issuer,
      MCP_PUBLIC_URL: RESOURCE,
      OAUTH_ISSUER: 'https://calendar.example.test',
      OAUTH_SIGNING_JWK: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })),
    });
  });
  afterAll(async () => {
    await ext.close();
    await as.close();
  });

  const call = async (token: string, name: string) =>
    ext.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, { authorization: `Bearer ${token}` });

  it('a sign-in that reaches no account is its hashed id; one in an account is its member', async () => {
    expect((await call(await as.mint({ sub: 'user_nobody' }), 'whoami')).status).toBe(200);
    const alex = (await ext.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    await ext.db.run(sql`UPDATE member SET idp_subject = ${'user_alex'}, login_seen_at = ${Date.now()} WHERE id = ${alex}`);
    expect((await call(await as.mint({ sub: 'user_alex' }), 'list_event_types')).status).toBe(200);
    const [nobody, member, ...rest] = await settled(ext);
    expect(rest).toEqual([]);
    // The hashed per-person id, never the external server's raw subject.
    expect(nobody).toMatchObject({ distinctId: signInKey({ token: { subject: 'user_nobody', expiresAtMs: 0 }, accounts: [] }), accountKey: null });
    expect(JSON.stringify(nobody)).not.toContain('user_nobody');
    expect(nobody!.properties).toMatchObject({ $mcp_tool_name: 'whoami', credential_type: 'oauth', $process_person_profile: false });
    expect(member).toMatchObject({ distinctId: 'alex@example.com', accountKey: 'acme' });
    expect(member!.properties).toMatchObject({ $mcp_tool_name: 'list_event_types', credential_type: 'oauth', account_code: 'acme' });
    expect(member!.properties).not.toHaveProperty('$process_person_profile');
  });
});
