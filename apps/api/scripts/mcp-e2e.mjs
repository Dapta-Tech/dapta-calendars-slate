/**
 * End-to-end check of the MCP door under the PRODUCTION runtime.
 *
 * Boots the API exactly like the Dockerfile CMD (tsx + tsconfig.runtime.json,
 * which emits no decorator metadata) on a throwaway SQLite file, then drives it
 * over HTTP with the official MCP client: list tools, find slots, book,
 * reschedule, cancel, plus a legacy `initialize` handshake; then the newer
 * tools: hold a slot and book it with the hold (an anonymous hold's id from
 * any address; a key's hold only by that key, never a second one), confirm
 * and decline requests that wait for the host, and a round-robin team booking.
 * Unit specs build classes by hand and cannot see a missing `@Inject`; this can.
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
import { randomUUID } from 'node:crypto';
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
const ALL_SCOPES = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const key = (await createApiKey(db, { accountId, name: 'e2e', scopes: ALL_SCOPES })).plaintext;
const otherKey = (await createApiKey(db, { accountId, name: 'e2e-other', scopes: ALL_SCOPES })).plaintext;
// A one-host event whose bookings wait for the host to confirm (Jordan's).
const jordan = await db.get(sql`SELECT id, default_schedule_id FROM member WHERE handle = 'jordan-lee'`);
await db.run(
  sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, schedule_id, hidden,
        minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval, requires_confirmation, created_at)
      VALUES (${randomUUID()}, ${accountId}, ${jordan.id}, 'approval-call', 'Approval Call', 30, ${jordan.default_schedule_id}, 0,
        120, 0, 0, 30, 1, ${Date.now()})`,
);
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
  if (legacy.status !== 200 || !legacyText.includes('"dcal"')) fail(`legacy initialize: ${legacy.status} ${legacyText}`);
  say(`legacy initialize (2025-06-18) -> ${legacy.status}, no session id: ${legacy.headers.get('mcp-session-id') === null}`);

  // 2. The SDK client, anonymous: public tools only.
  const anon = new Client({ name: 'e2e-anon', version: '1' });
  await anon.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const tools = (await anon.listTools()).tools.map((t) => t.name);
  say(`anonymous tools/list -> ${tools.length} tools: ${tools.join(', ')}`);
  if (tools.length !== 17) fail('expected 17 tools');
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

  // 5. Hold, then book with the hold. An anonymous hold_id is the capability
  // itself (the address may change between calls); a key's hold is that key's.
  const page = 'https://calendar.example.test/acme/alex-rivera/intro-call';
  const holdArgs = { booking_page_url: page, start: all[11].start, time_zone: 'America/Bogota', idempotency_key: idem('e2e-hold-00001') };
  const held = await anon.callTool({ name: 'hold_slot', arguments: holdArgs });
  if (held.isError) fail(`hold_slot: ${held.content[0].text}`);
  const hold = held.structuredContent.hold;
  say(`hold_slot -> ${hold.hold_id.slice(0, 9)}... until ${hold.expires_at} (${hold.expires_at_utc})`);
  const after = (await anon.callTool({ name: 'find_available_slots', arguments: { booking_page_url: page, time_zone: 'America/Bogota' } })).structuredContent;
  if (after.days.flatMap((d) => d.slots).some((x) => x.start_utc === hold.start_utc)) fail('a held slot was still offered');
  say('the held time is no longer offered');
  const withHold = await anon.callTool({
    name: 'book_meeting',
    arguments: { booking_page_url: page, start: all[11].start, attendee: { name: 'Held Invitee', email: 'held@example.org', time_zone: 'America/Bogota' }, answers: { company: 'Held Co' }, hold_id: hold.hold_id, idempotency_key: idem('e2e-held-00001') },
  });
  if (withHold.isError) fail(`book_meeting with hold: ${withHold.content[0].text}`);
  say(`book_meeting with hold_id -> ${withHold.structuredContent.booking.uid} ${withHold.structuredContent.booking.status}`);
  const keyHeld = await c.callTool({ name: 'hold_slot', arguments: { event_type_id: intro.id, start: all[13].start, time_zone: 'UTC', idempotency_key: idem('e2e-hold-00002') } });
  if (keyHeld.isError) fail(`hold_slot with a key: ${keyHeld.content[0].text}`);
  const keyHold = keyHeld.structuredContent.hold;
  const o = new Client({ name: 'e2e-other-key', version: '1' });
  await o.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${otherKey}` } } }));
  const byKey = (client, name, key) =>
    client.callTool({
      name: 'create_booking',
      arguments: { event_type_id: intro.id, start: all[13].start, attendee: { name, email: `${name.toLowerCase()}@example.org`, time_zone: 'UTC' }, answers: { company: 'K' }, hold_id: keyHold.hold_id, idempotency_key: idem(key) },
    });
  const stolen = await byKey(o, 'Thief', 'e2e-steal-0001');
  if (!stolen.isError || !stolen.content[0].text.includes('HOLD_NOT_FOUND')) fail(`another key used the hold: ${JSON.stringify(stolen.content)}`);
  say(`another key with a key's hold_id -> ${stolen.content[0].text.slice(0, 40)}...`);
  const keyBooked = await byKey(c, 'Owner', 'e2e-held-00002');
  if (keyBooked.isError) fail(`create_booking with its own hold: ${keyBooked.content[0].text}`);
  say(`the key that held it books it -> ${keyBooked.structuredContent.booking.uid}`);

  // 6. Requests that wait for the host: list, confirm (twice), decline.
  const approval = 'https://calendar.example.test/acme/jordan-lee/approval-call';
  const open = (await anon.callTool({ name: 'find_available_slots', arguments: { booking_page_url: approval, time_zone: 'America/Bogota' } })).structuredContent.days.flatMap((d) => d.slots);
  const request = async (i, name) => {
    const r = await anon.callTool({
      name: 'book_meeting',
      arguments: { booking_page_url: approval, start: open[i].start, attendee: { name, email: `${name.toLowerCase()}@example.org`, time_zone: 'America/Bogota' }, idempotency_key: idem(`e2e-request-${i}-000`) },
    });
    if (r.isError || r.structuredContent.booking.status !== 'pending') fail(`a request was not pending: ${JSON.stringify(r.content)}`);
    return r.structuredContent.booking.uid;
  };
  const toConfirm = await request(0, 'Penny');
  const toDecline = await request(2, 'Dora');
  const pending = (await c.callTool({ name: 'list_pending_bookings', arguments: {} })).structuredContent.bookings.map((b) => b.uid);
  if (!pending.includes(toConfirm) || !pending.includes(toDecline)) fail('list_pending_bookings missed a request');
  say(`list_pending_bookings -> ${pending.length} pending`);
  const confirmed = await c.callTool({ name: 'confirm_booking', arguments: { booking_uid: toConfirm, idempotency_key: idem('e2e-confirm-0001') } });
  if (confirmed.isError || confirmed.structuredContent.booking.status !== 'accepted') fail(`confirm_booking: ${JSON.stringify(confirmed.content)}`);
  const twice = await c.callTool({ name: 'confirm_booking', arguments: { booking_uid: toConfirm, idempotency_key: idem('e2e-confirm-0002') } });
  if (twice.isError || twice.structuredContent.already_applied !== true) fail('a second confirm was not idempotent');
  say(`confirm_booking -> ${confirmed.structuredContent.booking.status}; again -> already_applied ${twice.structuredContent.already_applied}`);
  const declined = await c.callTool({ name: 'decline_booking', arguments: { booking_uid: toDecline, reason: 'e2e', idempotency_key: idem('e2e-decline-0001') } });
  if (declined.isError || declined.structuredContent.booking.status !== 'rejected') fail(`decline_booking: ${JSON.stringify(declined.content)}`);
  say(`decline_booking -> ${declined.structuredContent.booking.status}`);

  // 7. A round-robin team: find, then book; the host is picked at booking time.
  const team = 'https://calendar.example.test/acme/team/sales';
  const teamSlots = await anon.callTool({ name: 'find_team_slots', arguments: { booking_page_url: team, time_zone: 'America/Bogota' } });
  if (teamSlots.isError) fail(`find_team_slots: ${teamSlots.content[0].text}`);
  const tInfo = teamSlots.structuredContent.team;
  const tFirst = teamSlots.structuredContent.days.flatMap((d) => d.slots)[20];
  say(`find_team_slots -> team ${tInfo.name}, ${tInfo.scheduling_type}, ${tInfo.host_count} hosts, ${teamSlots.structuredContent.slot_count} slots`);
  const teamBooked = await anon.callTool({
    name: 'book_team_meeting',
    arguments: { booking_page_url: team, start: tFirst.start, attendee: { name: 'Team Invitee', email: 'team@example.org', time_zone: 'America/Bogota' }, idempotency_key: idem('e2e-team-00001') },
  });
  if (teamBooked.isError || teamBooked.structuredContent.assigned_hosts.length !== 1) fail(`book_team_meeting: ${JSON.stringify(teamBooked.content)}`);
  say(`book_team_meeting -> ${teamBooked.structuredContent.booking.uid} with ${teamBooked.structuredContent.assigned_hosts.join(', ')}`);

  await Promise.all([anon.close(), c.close(), o.close()]);
  const audit = logs.join('').split('\n').filter((l) => l.includes('mcp.tool_call'));
  say(`${audit.length} audit lines on stdout; sample: ${audit[0]}`);
  if (logs.join('').includes(key) || logs.join('').includes(otherKey)) fail('an API key appeared in the server output');
  if (logs.join('').includes(hold.hold_id) || logs.join('').includes(keyHold.hold_id)) fail('a hold id appeared in the server output');
  if (audit.length < 20) fail('missing audit lines');
  ok = true;
  say('PASS');
} finally {
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
