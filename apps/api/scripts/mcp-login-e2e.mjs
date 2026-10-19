/**
 * End-to-end check of the MCP door as an OAuth RESOURCE SERVER for an external
 * authorization server, under the PRODUCTION runtime: the API booted like the
 * Dockerfile CMD (tsx + tsconfig.runtime.json, no decorator metadata) on a
 * throwaway SQLite file, and a local stand-in authorization server (RS256 keys
 * generated here, its metadata and JWKS served on a loopback port) that mints
 * the access tokens a real one would.
 *
 *   discovery (protected-resource metadata, the server's metadata served from
 *   this origin), the built-in server staying dormant with its settings still
 *   present, the 401 challenge, 403 for a sign-in linked to no member, then
 *   with a sign-in: tools/list, whoami, list_my_accounts, list_event_types,
 *   find_available_slots, create_booking, get_booking and cancel_booking; a
 *   sign-in reaching two accounts picks one with account_id; the audit lines.
 *
 *   pnpm run build:packages              # workspace packages, once
 *   cd apps/api && pnpm e2e:mcp-login    # port 4798, or: pnpm e2e:mcp-login 4800
 *
 * Runs under tsx itself because the workspace packages ship extensionless ESM.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDb, migrate, recordMemberIdpSubject, seed, sql } from '@slate/db';
import { startFakeAs } from '../src/oauth/fake-as.ts';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 4798);
const base = `http://localhost:${port}`;
const resource = `${base}/mcp`;
const dir = mkdtempSync(join(tmpdir(), 'mcp-login-e2e-'));
const databaseUrl = `file:${join(dir, 'e2e.db')}`;
/** Labels for idempotency keys (a helper so secret scanners do not mistake them for credentials). */
const idem = (label) => label;
const say = (m) => console.log(`[login-e2e] ${m}`);
const fail = (m) => {
  throw new Error(`E2E FAILED: ${m}`);
};
const check = (cond, m) => {
  if (!cond) fail(m);
  say(`ok  ${m}`);
};

const as = await startFakeAs({ audience: resource });
say(`stand-in authorization server at ${as.issuer}`);

// The data a web login leaves behind: the person's subject on their member.
const db = await createDb(databaseUrl);
await migrate(db);
await seed(db);
const acme = (await db.get(sql`SELECT id FROM account WHERE code = 'acme'`)).id;
const alex = (await db.get(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`)).id;
await recordMemberIdpSubject(db, acme, alex, 'user_01E2EALEX');
// A second person who is an admin in acme and the owner of another account.
const now = Date.now();
const globex = randomUUID();
const bo = randomUUID();
const casey = randomUUID();
await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${globex}, 'globex', 'Globex', ${now})`);
await db.run(sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, role, created_at) VALUES (${bo}, ${globex}, 'bo', 'Bo', 'UTC', 'owner', ${now})`);
await db.run(sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, role, created_at) VALUES (${casey}, ${acme}, 'casey', 'Casey', 'UTC', 'admin', ${now})`);
await recordMemberIdpSubject(db, globex, bo, 'user_01E2EMULTI');
await recordMemberIdpSubject(db, acme, casey, 'user_01E2EMULTI');
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
    OAUTH_ENABLED: 'true',
    OAUTH_AUTHORIZATION_SERVER: as.issuer,
    MCP_PUBLIC_URL: resource,
    // The built-in server's settings, still present (as on dev during the switch): ignored.
    OAUTH_ISSUER: base,
    OAUTH_SIGNING_JWK: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));
say(`started API pid ${child.pid} on :${port} (tsx + tsconfig.runtime.json)`);

const post = (body, token) =>
  fetch(resource, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const connect = async (token) => {
  const c = new Client({ name: 'login-e2e', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
};

let ok = false;
const clients = [];
try {
  for (let i = 0; ; i += 1) {
    if (i > 150) fail(`API did not come up:\n${logs.join('')}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  say('API healthy');
  check(logs.join('').includes(`external authorization server ${as.issuer}`), 'boot log names the external authorization server');

  // --- Discovery -------------------------------------------------------------
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check(prm.resource === resource && prm.authorization_servers.length === 1 && prm.authorization_servers[0] === as.issuer, 'protected-resource metadata names the external server');
  check(Array.isArray(prm.scopes_supported) && prm.scopes_supported.length === 0, 'no scopes advertised');
  const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check(asMeta.issuer === as.issuer && asMeta.jwks_uri === as.jwksUrl, 'the external server metadata is served from this origin');
  check((await fetch(`${base}/oauth/jwks`)).status === 404, 'the built-in server is not mounted (/oauth/jwks 404)');

  // --- The door without and with a bad sign-in --------------------------------
  const anon = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_bookings', arguments: {} } });
  const challenge = anon.headers.get('www-authenticate');
  check(anon.status === 401 && challenge === `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, `no token: 401 ${challenge}`);
  const expired = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, await as.mint({ sub: 'user_01E2EALEX', exp: Math.floor(Date.now() / 1000) - 120 }));
  check(expired.status === 401 && (expired.headers.get('www-authenticate') ?? '').startsWith('Bearer error="invalid_token"'), 'expired token: 401 invalid_token');
  const stranger = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, await as.mint({ sub: 'user_01NOBODY' }));
  const strangerBody = await stranger.json();
  check(stranger.status === 403 && stranger.headers.get('www-authenticate') === null && strangerBody.error.message.includes('Open dCal on the web once'), `unlinked sign-in: 403 "${strangerBody.error.message}"`);

  // --- One account -------------------------------------------------------------
  const token = await as.mint({ sub: 'user_01E2EALEX', client_id: 'https://client.example.test/metadata.json' });
  const c = await connect(token);
  clients.push(c);
  const tools = (await c.listTools()).tools.map((t) => t.name);
  check(tools.length === 11 && tools.includes('list_my_accounts'), `tools/list -> ${tools.length} tools`);
  const who = (await c.callTool({ name: 'whoami', arguments: {} })).structuredContent;
  check(who.account.code === 'acme' && who.key.prefix === `login:${alex.slice(0, 8)}` && who.key.scopes.length === 5, `whoami -> ${who.account.code}, ${who.key.prefix}, ${who.key.scopes.length} scopes`);
  const mine = (await c.callTool({ name: 'list_my_accounts', arguments: {} })).structuredContent.accounts;
  check(mine.length === 1 && mine[0].id === acme, `list_my_accounts -> ${mine.map((a) => a.name).join(', ')}`);
  const types = (await c.callTool({ name: 'list_event_types', arguments: {} })).structuredContent.event_types;
  const intro = types.find((t) => t.slug === 'intro-call');
  check(!!intro, `list_event_types -> ${types.map((t) => t.slug).join(', ')}`);
  const slots = (await c.callTool({ name: 'find_available_slots', arguments: { event_type_id: intro.id, time_zone: 'America/Bogota' } })).structuredContent;
  const all = slots.days.flatMap((d) => d.slots);
  check(all.length > 3, `find_available_slots -> ${all.length} slots`);
  const created = await c.callTool({
    name: 'create_booking',
    arguments: {
      event_type_id: intro.id,
      start: all[3].start,
      attendee: { name: 'Login Invitee', email: 'login-e2e@example.org', time_zone: 'America/Bogota' },
      answers: { company: 'Login Co' },
      idempotency_key: idem('login-e2e-create-01'),
    },
  });
  if (created.isError) fail(`create_booking: ${created.content[0].text}`);
  const uid = created.structuredContent.booking.uid;
  check(created.structuredContent.booking.status === 'accepted', `create_booking -> ${uid} at ${created.structuredContent.booking.start}`);
  const got = (await c.callTool({ name: 'get_booking', arguments: { booking_uid: uid } })).structuredContent;
  check(got.booking.uid === uid, 'get_booking -> the same booking');
  const cancelled = await c.callTool({ name: 'cancel_booking', arguments: { booking_uid: uid, reason: 'e2e done' } });
  check(!cancelled.isError && cancelled.structuredContent.booking.status === 'cancelled', 'cancel_booking -> cancelled');
  const foreign = await c.callTool({ name: 'list_event_types', arguments: { account_id: globex } });
  check(foreign.isError && foreign.content[0].text.startsWith('NOT_FOUND'), 'another account by account_id -> NOT_FOUND');

  // --- Two accounts ----------------------------------------------------------
  const multi = await connect(await as.mint({ sub: 'user_01E2EMULTI' }));
  clients.push(multi);
  const both = (await multi.callTool({ name: 'list_my_accounts', arguments: {} })).structuredContent.accounts;
  check(both.length === 2, `two accounts: list_my_accounts -> ${both.map((a) => a.name).join(', ')}`);
  const unnamed = await multi.callTool({ name: 'list_event_types', arguments: {} });
  check(unnamed.isError && unnamed.content[0].text.startsWith('ACCOUNT_REQUIRED'), 'two accounts, no account_id -> ACCOUNT_REQUIRED');
  const named = (await multi.callTool({ name: 'whoami', arguments: { account_id: globex } })).structuredContent;
  check(named.account.code === 'globex' && named.key.prefix === `login:${bo.slice(0, 8)}`, `account_id picks the account -> ${named.account.code} as ${named.key.prefix}`);

  // --- Logs ------------------------------------------------------------------
  await Promise.all(clients.map((x) => x.close()));
  const out = logs.join('');
  const audit = out.split('\n').filter((l) => l.includes('mcp.tool_call'));
  const booking = audit.map((l) => JSON.parse(l.slice(l.indexOf('{')))).find((l) => l.tool === 'create_booking');
  check(booking?.caller === `login:${alex.slice(0, 8)}` && booking.client === 'https://client.example.test/metadata.json', `audit: ${JSON.stringify(booking)}`);
  check(!out.includes(token), 'no access token in the server output');
  ok = true;
  say('PASS');
} finally {
  child.kill('SIGTERM');
  await as.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
