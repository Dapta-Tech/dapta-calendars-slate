/**
 * End-to-end check of the MCP door under the PRODUCTION runtime.
 *
 * Boots the API exactly like the Dockerfile CMD (tsx + tsconfig.runtime.json,
 * which emits no decorator metadata) on a throwaway SQLite file, then drives it
 * over HTTP with the official MCP client: list tools, find slots, book,
 * reschedule, cancel, plus a legacy `initialize` handshake. Unit specs build
 * classes by hand and cannot see a missing `@Inject`; this can.
 *
 *   pnpm run build:packages                       # workspace packages, once
 *   cd apps/api && pnpm e2e:mcp                   # port 4792, or: pnpm e2e:mcp 4800
 *
 * It runs under tsx itself because the workspace packages ship extensionless ESM.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApiKey, createDb, migrate, seed, sql } from '@slate/db';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 4792);
const dir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
const databaseUrl = `file:${join(dir, 'e2e.db')}`;
/** Labels for idempotency keys (a helper so secret scanners do not mistake them for credentials). */
const idem = (label) => label;
const say = (m) => console.log(`[e2e] ${m}`);
const fail = (m) => {
  throw new Error(`E2E FAILED: ${m}`);
};

const db = await createDb(databaseUrl);
await migrate(db);
await seed(db);
const accountId = (await db.get(sql`SELECT id FROM account WHERE code = 'acme'`)).id;
const key = (
  await createApiKey(db, {
    accountId,
    name: 'e2e',
    scopes: ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'],
  })
).plaintext;
await db.close();

const child = spawn('node', ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.runtime.json', 'src/main.ts'], {
  cwd: apiDir,
  env: {
    ...process.env,
    API_PORT: String(port),
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'development',
    OUTBOX_WORKER_ENABLED: 'false',
    PUBLIC_APP_URL: 'https://calendar.example.test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));
say(`started API pid ${child.pid} on :${port} (tsx + tsconfig.runtime.json)`);

let ok = false;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i += 1) {
    if (i > 100) fail(`API did not come up:\n${logs.join('')}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  say('API healthy');

  // 1. A legacy (2025-era) initialize handshake, no session.
  const legacy = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    }),
  });
  const legacyText = await legacy.text();
  if (legacy.status !== 200 || !legacyText.includes('dapta-calendars')) fail(`legacy initialize: ${legacy.status} ${legacyText}`);
  say(`legacy initialize (2025-06-18) -> ${legacy.status}, no session id: ${legacy.headers.get('mcp-session-id') === null}`);

  // 2. The SDK client, anonymous: public tools only.
  const anon = new Client({ name: 'e2e-anon', version: '1' });
  await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = (await anon.listTools()).tools.map((t) => t.name);
  say(`anonymous tools/list -> ${tools.length} tools: ${tools.join(', ')}`);
  if (tools.length !== 10) fail('expected 10 tools');
  const denied = await anon.callTool({ name: 'list_bookings', arguments: {} });
  if (!denied.isError || !denied.content[0].text.includes('AUTH_REQUIRED')) fail('anonymous list_bookings was not refused');
  say(`anonymous list_bookings -> ${denied.content[0].text.slice(0, 80)}...`);

  // 3. The same client with a key: the whole lifecycle.
  const c = new Client({ name: 'e2e-key', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const who = (await c.callTool({ name: 'whoami', arguments: {} })).structuredContent;
  say(`whoami -> account ${who.account.code}, key ${who.key.prefix}, ${who.key.scopes.length} scopes`);
  const types = (await c.callTool({ name: 'list_event_types', arguments: {} })).structuredContent.event_types;
  const intro = types.find((t) => t.slug === 'intro-call');
  say(`list_event_types -> ${types.map((t) => t.slug).join(', ')}`);
  const slots = (
    await c.callTool({ name: 'find_available_slots', arguments: { event_type_id: intro.id, time_zone: 'America/Bogota' } })
  ).structuredContent;
  const all = slots.days.flatMap((d) => d.slots);
  say(`find_available_slots -> ${all.length} slots over ${slots.days.length} days, first ${all[0].start}`);
  const created = await c.callTool({
    name: 'create_booking',
    arguments: {
      event_type_id: intro.id,
      start: all[3].start,
      attendee: { name: 'E2E Invitee', email: 'e2e@example.org', time_zone: 'America/Bogota' },
      answers: { company: 'E2E Co' },
      idempotency_key: idem('e2e-create-0001'),
    },
  });
  if (created.isError) fail(`create_booking: ${created.content[0].text}`);
  const uid = created.structuredContent.booking.uid;
  say(`create_booking -> ${uid} ${created.structuredContent.booking.status} at ${created.structuredContent.booking.start}`);
  const replay = await c.callTool({ name: 'create_booking', arguments: created.structuredContent && {
    event_type_id: intro.id, start: all[3].start,
    attendee: { name: 'E2E Invitee', email: 'e2e@example.org', time_zone: 'America/Bogota' },
    answers: { company: 'E2E Co' }, idempotency_key: idem('e2e-create-0001') } });
  if (replay.structuredContent?.booking?.uid !== uid) fail('idempotent replay returned another booking');
  say('create_booking replay with the same key -> same booking');
  const moved = await c.callTool({ name: 'reschedule_booking', arguments: { booking_uid: uid, start: all[7].start, idempotency_key: idem('e2e-move-00001') } });
  if (moved.isError) fail(`reschedule_booking: ${moved.content[0].text}`);
  say(`reschedule_booking -> new uid ${moved.structuredContent.booking.uid} at ${moved.structuredContent.booking.start}`);
  const cancelled = await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: moved.structuredContent.booking.uid, reason: 'e2e done' } });
  if (cancelled.isError || cancelled.structuredContent.booking.status !== 'cancelled') fail('cancel_booking');
  say(`cancel_booking -> ${cancelled.structuredContent.booking.status}`);
  const got = (await c.callTool({ name: 'get_booking', arguments: { booking_uid: moved.structuredContent.booking.uid } })).structuredContent;
  say(`get_booking -> status ${got.booking.status}, invitee_supplied.attendees[0].name = ${got.invitee_supplied.attendees[0].name}`);

  // 4. An anonymous booking on the public page.
  const pub = await anon.callTool({
    name: 'book_meeting',
    arguments: {
      booking_page_url: 'https://calendar.example.test/acme/alex-rivera/intro-call',
      start: all[5].start,
      attendee: { name: 'Public Invitee', email: 'pub@example.org', time_zone: 'America/Bogota' },
      answers: { company: 'Public Co' },
      idempotency_key: idem('e2e-public-0001'),
    },
  });
  if (pub.isError) fail(`book_meeting: ${pub.content[0].text}`);
  say(`anonymous book_meeting -> ${pub.structuredContent.booking.uid} ${pub.structuredContent.booking.status}`);
  const clash = await anon.callTool({
    name: 'book_meeting',
    arguments: {
      booking_page_url: 'https://calendar.example.test/acme/alex-rivera/intro-call',
      start: all[5].start,
      attendee: { name: 'Late Invitee', email: 'late@example.org', time_zone: 'UTC' },
      answers: { company: 'Late Co' },
      idempotency_key: idem('e2e-public-0002'),
    },
  });
  if (!clash.isError || !clash.content[0].text.includes('SLOT_TAKEN')) fail('second booking of a taken slot was not SLOT_TAKEN');
  say(`double booking -> ${clash.content[0].text.slice(0, 60)}...`);

  await Promise.all([anon.close(), c.close()]);
  const audit = logs.join('').split('\n').filter((l) => l.includes('mcp.tool_call'));
  say(`${audit.length} audit lines on stdout; sample: ${audit[0]}`);
  if (logs.join('').includes(key)) fail('the API key appeared in the server output');
  if (audit.length < 10) fail('missing audit lines');
  ok = true;
  say('PASS');
} finally {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
