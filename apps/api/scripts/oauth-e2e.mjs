/**
 * End-to-end check of the MCP OAuth connector, booted like production:
 * the API under the Dockerfile's runtime (tsx + tsconfig.runtime.json, no
 * decorator metadata) and the web app from `next build` + `next start`, on a
 * throwaway SQLite file. A headless browser plays the person, this script
 * plays the MCP client (a public client with PKCE, like Claude Code):
 *
 *   discovery, 401 challenge, dynamic registration, authorize, the real login
 *   and consent pages, code exchange, MCP tool calls with the token, 403
 *   step-up, refresh rotation, a denied request, the Claude Code metadata
 *   document (CIMD) when the network allows, Disconnect from Connected apps,
 *   refresh refused, and the access token's 401 once it expires.
 *
 *   pnpm run build:packages            # workspace packages, once
 *   cd apps/api && pnpm e2e:oauth      # API :4795, web :3795 (E2E_SKIP_BUILD=1 reuses .next)
 *
 * Runs under tsx itself because the workspace packages ship extensionless ESM.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDb, migrate, seed } from '@slate/db';

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = resolve(apiDir, '../web');
const apiPort = Number(process.env.E2E_OAUTH_API_PORT ?? 4795);
const webPort = Number(process.env.E2E_OAUTH_WEB_PORT ?? 3795);
const issuer = `http://localhost:${apiPort}`;
const resource = `${issuer}/mcp`;
const web = `http://localhost:${webPort}`;
const evidence = process.env.E2E_EVIDENCE_DIR ?? join(tmpdir(), 'oauth-e2e-evidence');
const TTL = 60;
const READ = 'event-types:read availability:read bookings:read';

const say = (m) => console.log(`[oauth-e2e] ${m}`);
const fail = (m) => {
  throw new Error(`E2E FAILED: ${m}`);
};
const check = (cond, m) => {
  if (!cond) fail(m);
  say(`ok  ${m}`);
};

const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
mkdirSync(evidence, { recursive: true });
const databaseUrl = `file:${join(dir, 'e2e.db')}`;
const db = await createDb(databaseUrl);
await migrate(db);
await seed(db);
await db.close();
const signingJwk = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));

const children = [];
function start(name, cmd, args, cwd, env) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  children.push(child);
  say(`started ${name} pid ${child.pid}`);
  return logs;
}
async function waitFor(url, logs, what, tries = 300) {
  for (let i = 0; ; i += 1) {
    if (i > tries) fail(`${what} did not come up:\n${logs.join('').slice(-4000)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const apiEnv = {
  API_PORT: String(apiPort),
  DATABASE_URL: databaseUrl,
  NODE_ENV: 'development',
  OUTBOX_WORKER_ENABLED: 'false',
  PUBLIC_APP_URL: web,
  // Signed out means signed out (no fallback to the seeded host), so the
  // consent page has to send the person through the real login.
  AUTH_LOCAL_STRICT: 'true',
  OAUTH_ENABLED: 'true',
  OAUTH_ISSUER: issuer,
  MCP_PUBLIC_URL: resource,
  OAUTH_SIGNING_JWK: signingJwk,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: String(TTL),
};
const webEnv = {
  API_URL: issuer,
  NEXT_PUBLIC_API_URL: issuer,
  MCP_PUBLIC_URL: resource,
  API_PUBLIC_URL: issuer,
  AUTH_PROVIDER: 'local',
  NEXT_PUBLIC_PRODUCT_NAME: 'Dapta Calendars',
};

let ok = false;
let browser;
try {
  const apiLogs = start('API (tsx + tsconfig.runtime.json)', 'node', ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.runtime.json', 'src/main.ts'], apiDir, apiEnv);
  if (process.env.E2E_SKIP_BUILD !== '1') {
    say('next build (production bundle)…');
    const built = spawnSync('node', ['node_modules/next/dist/bin/next', 'build'], { cwd: webDir, env: { ...process.env, ...webEnv }, encoding: 'utf8' });
    if (built.status !== 0) fail(`next build failed:\n${(built.stdout + built.stderr).slice(-4000)}`);
  }
  const webLogs = start('web (next start)', 'node', ['node_modules/next/dist/bin/next', 'start', '-p', String(webPort)], webDir, webEnv);
  await waitFor(`${issuer}/health`, apiLogs, 'API');
  await waitFor(`${web}/login`, webLogs, 'web');
  say('API and web healthy');

  // --- Discovery and the challenge -------------------------------------------
  const prm = await (await fetch(`${issuer}/.well-known/oauth-protected-resource/mcp`)).json();
  check(prm.resource === resource && prm.authorization_servers[0] === issuer, 'protected-resource metadata names the resource and the issuer');
  check(prm.scopes_supported.join(' ') === READ && !prm.scopes_supported.includes('offline_access'), 'PRM scopes are the read-only set, no offline_access');
  const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  check(as.issuer === issuer && as.code_challenge_methods_supported.join() === 'S256', 'AS metadata: issuer and S256 only');
  check(as.authorization_response_iss_parameter_supported === true && as.client_id_metadata_document_supported === true, 'AS metadata: RFC 9207 iss and CIMD advertised');
  check(as.token_endpoint_auth_methods_supported.includes('none') && typeof as.registration_endpoint === 'string', 'AS metadata: public clients and DCR');

  const unauth = await fetch(resource, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_bookings', arguments: {} } }),
  });
  const challenge = unauth.headers.get('www-authenticate') ?? '';
  check(unauth.status === 401 && challenge.includes(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`), `protected tool without a token: 401 ${challenge}`);

  // --- The client: a loopback callback, like Claude Code ----------------------
  const callbacks = [];
  const cb = createServer((req, res) => {
    callbacks.push(new URL(req.url, 'http://127.0.0.1'));
    res.writeHead(200, { 'content-type': 'text/plain' }).end('You can close this window.');
  });
  await new Promise((r) => cb.listen(0, '127.0.0.1', r));
  const cbPort = cb.address().port;
  const redirect = `http://127.0.0.1:${cbPort}/callback`;
  const reg = await fetch(`${issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E Agent', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }),
  });
  const client = await reg.json();
  check(reg.status === 201 && client.client_id, `dynamic registration: client ${client.client_id}`);
  const refused = await fetch(`${issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
  });
  check(refused.status === 400, 'registration outside the redirect allowlist refused');

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };
  const authorizeUrl = (clientId, redirectUri, p, scope, state) =>
    `${issuer}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: p.challenge, code_challenge_method: 'S256', scope, state, resource })}`;
  const token = async (params) => {
    const res = await fetch(`${issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { status: res.status, json: await res.json() };
  };
  const nextCallback = async (before) => {
    for (let i = 0; i < 100 && callbacks.length === before; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (callbacks.length === before) fail('the browser never reached the client callback');
    return callbacks.at(-1);
  };

  // --- The person: real login and consent pages in a headless browser ---------
  const require = createRequire(join(webDir, 'package.json'));
  const playwright = await import(pathToFileURL(require.resolve('@playwright/test')).href);
  const chromium = playwright.chromium ?? playwright.default.chromium;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const p1 = pkce();
  await page.goto(authorizeUrl(client.client_id, redirect, p1, `${READ} offline_access`, 'state-1'));
  await page.waitForURL(/\/login\?next=%2Fauth%2Fconsent/);
  check(true, 'signed out: the consent request sends the person through the login, keeping the request');
  await page.fill('input[name="email"]', 'alex@example.com');
  await Promise.all([page.waitForURL(/\/auth\/consent\?uid=/), page.click('button[type="submit"]')]);
  await page.getByRole('heading', { level: 1 }).waitFor();
  const heading = await page.getByRole('heading', { level: 1 }).innerText();
  const body = await page.locator('main').innerText();
  check(heading.includes('E2E Agent') && heading.includes('Dapta Calendars'), `consent heading: "${heading}"`);
  check(body.includes(`Identified as 127.0.0.1:${cbPort}`) && body.includes('Acme Inc.'), 'consent shows the identifying host and the workspace');
  check(body.includes('See event types') && body.includes('Check free times') && body.includes('Read bookings'), 'consent lists the scopes in plain words');
  check(body.includes('runs on your own computer'), 'consent warns about a loopback redirect');
  await page.screenshot({ path: join(evidence, 'consent-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: join(evidence, 'consent-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const before1 = callbacks.length;
  await page.getByRole('button', { name: 'Allow' }).click();
  const back1 = await nextCallback(before1);
  check(back1.searchParams.get('state') === 'state-1' && back1.searchParams.get('iss') === issuer && back1.searchParams.get('code'), `code returned with state and RFC 9207 iss=${back1.searchParams.get('iss')}`);

  const t1 = await token({ grant_type: 'authorization_code', code: back1.searchParams.get('code'), code_verifier: p1.verifier, redirect_uri: redirect, client_id: client.client_id, resource });
  check(t1.status === 200 && t1.json.refresh_token && t1.json.expires_in === TTL, `token exchange (PKCE, public client): scope "${t1.json.scope}"`);
  const claims = JSON.parse(Buffer.from(t1.json.access_token.split('.')[1], 'base64url').toString());
  check(claims.aud === resource && claims.iss === issuer, `access token aud=${claims.aud} iss=${claims.iss}`);

  // --- MCP with the token ------------------------------------------------------
  const mcp = new Client({ name: 'oauth-e2e', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${t1.json.access_token}` } } }));
  const who = await mcp.callTool({ name: 'whoami', arguments: {} });
  check(!who.isError && who.structuredContent.account.code === 'acme', `whoami: ${who.content[0].text}`);
  const events = await mcp.callTool({ name: 'list_event_types', arguments: {} });
  check(!events.isError && events.structuredContent.event_types.length > 0, `list_event_types: ${events.structuredContent.event_types.length} event types`);
  await mcp.close();

  const stepUp = await fetch(resource, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t1.json.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_booking', arguments: {} } }),
  });
  const stepChallenge = stepUp.headers.get('www-authenticate') ?? '';
  check(stepUp.status === 403 && stepChallenge.includes('insufficient_scope') && stepChallenge.includes(`scope="${READ} bookings:write"`), `write without the scope: 403 ${stepChallenge}`);

  // --- Refresh rotation --------------------------------------------------------
  const t2 = await token({ grant_type: 'refresh_token', refresh_token: t1.json.refresh_token, client_id: client.client_id });
  check(t2.status === 200 && t2.json.refresh_token !== t1.json.refresh_token, 'refresh rotates the refresh token');

  // --- A denied request ----------------------------------------------------------
  const p2 = pkce();
  await page.goto(authorizeUrl(client.client_id, redirect, p2, READ, 'state-deny'));
  await page.waitForURL(/\/auth\/consent\?uid=/);
  const before2 = callbacks.length;
  await page.getByRole('button', { name: 'Deny' }).click();
  const back2 = await nextCallback(before2);
  check(back2.searchParams.get('error') === 'access_denied' && back2.searchParams.get('iss') === issuer, 'Deny answers access_denied (with iss) to the client');

  // --- CIMD with Claude Code's real metadata document -------------------------
  const cimdId = 'https://claude.ai/oauth/claude-code-client-metadata';
  let cimdDoc = null;
  try {
    cimdDoc = await (await fetch(cimdId, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    say('skip CIMD with the real Claude Code document: not reachable from here');
  }
  if (cimdDoc?.client_id === cimdId) {
    const p3 = pkce();
    const cimdRedirect = `http://localhost:${cbPort}/callback`;
    await page.goto(authorizeUrl(cimdId, cimdRedirect, p3, READ, 'state-cimd'));
    await page.waitForURL(/\/auth\/consent\?uid=/);
    // The consent page fetches the client's metadata document first, so the root
    // loading skeleton (its own <main>) can still be on screen: wait for the card.
    await page.getByRole('heading', { name: /wants to use your/ }).waitFor();
    const cimdBody = await page.locator('main', { hasText: 'wants to use your' }).innerText();
    check(cimdBody.includes('Claude Code') && cimdBody.includes('Identified as claude.ai'), 'CIMD: consent names Claude Code, identified by the claude.ai host');
    const before3 = callbacks.length;
    await page.getByRole('button', { name: 'Allow' }).click();
    const back3 = await nextCallback(before3);
    const t3 = await token({ grant_type: 'authorization_code', code: back3.searchParams.get('code'), code_verifier: p3.verifier, redirect_uri: cimdRedirect, client_id: cimdId, resource });
    check(t3.status === 200 && t3.json.refresh_token, `CIMD: Claude Code's metadata, ephemeral loopback port ${cbPort}, token issued`);
  }

  // --- Disconnect from Connected apps -----------------------------------------
  await page.goto(`${web}/admin/developers/keys`);
  await page.getByRole('heading', { name: 'Connected apps' }).waitFor();
  await page.screenshot({ path: join(evidence, 'connected-apps.png'), fullPage: true });
  const disconnect = page.getByRole('button', { name: 'Disconnect · E2E Agent' }).first();
  check((await page.getByRole('button', { name: 'Disconnect · E2E Agent' }).count()) >= 1, 'Connected apps lists the E2E Agent connection');
  await disconnect.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await page.getByText('App disconnected.').waitFor();
  const t4 = await token({ grant_type: 'refresh_token', refresh_token: t2.json.refresh_token, client_id: client.client_id });
  check(t4.status === 400 && t4.json.error === 'invalid_grant', 'after Disconnect the refresh token is refused (invalid_grant)');

  // The access token in hand lives to its expiry (stated in the UI), then 401.
  const call = (bearer) =>
    fetch(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
  check((await call(t2.json.access_token)).status === 200, 'the outstanding access token still works until it expires');
  const exp2 = JSON.parse(Buffer.from(t2.json.access_token.split('.')[1], 'base64url').toString()).exp;
  // Past `exp` plus the verifier's 5 s clock tolerance.
  const wait = Math.max(0, exp2 * 1000 - Date.now()) + 7000;
  say(`waiting ${Math.round(wait / 1000)}s for the access token to expire…`);
  await new Promise((r) => setTimeout(r, wait));
  const expired = await call(t2.json.access_token);
  check(expired.status === 401 && (expired.headers.get('www-authenticate') ?? '').includes('invalid_token'), 'once expired: 401 invalid_token');

  ok = true;
  cb.close();
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
say(ok ? `PASS (screenshots in ${evidence})` : 'FAIL');
process.exit(ok ? 0 : 1);
