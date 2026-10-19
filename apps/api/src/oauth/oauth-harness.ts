import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { sql } from '@slate/db';
import { bootHarness, type Harness, type HarnessEnv } from '../mcp/mcp-harness';
import { OAuthService } from './oauth.service';

/**
 * Drive the OAuth authorization server the way a browser and an MCP client
 * do, over real HTTP against the whole AppModule: a cookie jar that honours
 * cookie paths, PKCE, the consent page's two API calls, the code exchange.
 * Used by the OAuth specs; the e2e script drives the real web page instead.
 */

/** A fresh EC P-256 private JWK, as OAUTH_SIGNING_JWK takes it. */
export function newSigningJwk(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
}

/** A port nothing is listening on right now (the issuer must be known before boot). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface OAuthHarness extends Harness {
  oauth: OAuthService;
  /** The OAuth server's audit lines (consent decisions, revocations). */
  oauthAudit: string[];
  issuer: string;
  resource: string;
  /** Impersonation headers of the seeded owner (the local auth stub honours them under NODE_ENV=test). */
  owner: Record<string, string>;
  ownerIds: { accountId: string; memberId: string };
  /** A plain member of the seeded account (not allowed to approve). */
  member: Record<string, string>;
  /** The other tenant's owner. */
  otherOwner: Record<string, string>;
}

export async function bootOAuth(env: HarnessEnv = {}): Promise<OAuthHarness> {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const resource = `${issuer}/mcp`;
  const h = await bootHarness(
    {
      OAUTH_ENABLED: 'true',
      OAUTH_ISSUER: issuer,
      MCP_PUBLIC_URL: resource,
      OAUTH_SIGNING_JWK: newSigningJwk(),
      RATE_LIMIT_ENABLED: 'false',
      ...env,
    },
    { port },
  );
  const owner = (await h.db.get<{ id: string; account_id: string }>(
    sql`SELECT id, account_id FROM member WHERE account_id = ${h.accountId} AND role = 'owner' ORDER BY created_at LIMIT 1`,
  ))!;
  const memberId = randomUUID();
  await h.db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, role, created_at)
        VALUES (${memberId}, ${h.accountId}, ${`m-${memberId.slice(0, 8)}`}, 'Plain Member', ${`plain-${memberId.slice(0, 8)}@acme.test`}, 'member', ${Date.now()})`,
  );
  const other = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.other.accountId} LIMIT 1`))!;
  const as = (accountId: string, member: string) => ({ 'x-slate-account': accountId, 'x-slate-member': member });
  const oauth = h.app.get(OAuthService);
  const oauthAudit: string[] = [];
  oauth.auditSink = (line) => oauthAudit.push(line);
  return Object.assign(h, {
    oauth,
    oauthAudit,
    issuer,
    resource,
    owner: as(h.accountId, owner.id),
    ownerIds: { accountId: h.accountId, memberId: owner.id },
    member: as(h.accountId, memberId),
    otherOwner: as(h.other.accountId, other.id),
  });
}

/** A cookie jar that sends a cookie only where its Path says, and forgets cleared ones. */
export class Browser {
  private readonly cookies = new Map<string, { value: string; path: string }>();

  constructor(private readonly origin: string) {}

  /** `GET` without following redirects; returns the response and its Location (absolute). */
  async get(url: string): Promise<{ res: Response; location: string | null }> {
    const target = new URL(url, this.origin);
    const res = await fetch(target, { redirect: 'manual', headers: { cookie: this.header(target.pathname) } });
    this.store(res);
    const loc = res.headers.get('location');
    return { res, location: loc ? new URL(loc, target).href : null };
  }

  cookieNames(): string[] {
    return [...this.cookies.keys()];
  }

  private header(path: string): string {
    return [...this.cookies]
      .filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`) || c.path === '/')
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
  }

  private store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
      const expired = attrs.some((a) => a.toLowerCase().startsWith('expires=') && Date.parse(a.slice(8)) < Date.now());
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, { value, path });
    }
  }
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface Client {
  client_id: string;
  redirect: string;
}

/** Register a public client through DCR. */
export async function registerClient(
  h: OAuthHarness,
  body: Record<string, unknown> = {},
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const res = await fetch(`${h.issuer}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Spec Agent',
      redirect_uris: ['http://localhost:7777/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      ...body,
    }),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

export async function publicClient(h: OAuthHarness, redirect = 'http://localhost:7777/callback'): Promise<Client> {
  const { res, json } = await registerClient(h, { redirect_uris: [redirect] });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${JSON.stringify(json)}`);
  return { client_id: String(json.client_id), redirect };
}

export interface AuthorizeOptions {
  scope?: string;
  resource?: string | null;
  pkce?: Pkce;
  redirect?: string;
  extra?: Record<string, string>;
  state?: string;
}

/** The authorization URL a client opens. */
export function authorizeUrl(h: OAuthHarness, client: Client, o: AuthorizeOptions = {}): string {
  const p = o.pkce ?? pkce();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: o.redirect ?? client.redirect,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: o.state ?? 'st-1',
    ...(o.scope !== undefined ? { scope: o.scope } : { scope: 'event-types:read availability:read bookings:read' }),
    ...(o.resource === null ? {} : { resource: o.resource ?? h.resource }),
    ...(o.extra ?? {}),
  });
  return `${h.issuer}/oauth/authorize?${q}`;
}

export interface Started {
  browser: Browser;
  uid: string;
  pkce: Pkce;
}

/** Open the authorization URL and follow to the consent page; returns the interaction uid. */
export async function startAuthorization(h: OAuthHarness, client: Client, o: AuthorizeOptions = {}): Promise<Started> {
  const p = o.pkce ?? pkce();
  const browser = new Browser(h.issuer);
  const first = await browser.get(authorizeUrl(h, client, { ...o, pkce: p }));
  if (first.res.status !== 303 || !first.location?.includes('/oauth/interaction/'))
    throw new Error(`authorize did not hand off to an interaction: ${first.res.status} ${first.location} ${await first.res.text()}`);
  const second = await browser.get(first.location);
  if (second.res.status !== 303 || !second.location) throw new Error(`interaction did not redirect: ${second.res.status}`);
  const consent = new URL(second.location);
  return { browser, uid: consent.searchParams.get('uid')!, pkce: p };
}

/** The consent page's decision call (what the web server does with the host session). */
export async function decide(h: OAuthHarness, uid: string, decision: 'approve' | 'deny', who = h.owner): Promise<Response> {
  return fetch(`${h.issuer}/v1/oauth/consent/${encodeURIComponent(uid)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...who },
    body: JSON.stringify({ decision }),
  });
}

/** After the decision: the browser follows the ticket back, then resumes; returns the final client redirect. */
export async function followDecision(started: Started, redirectTo: string): Promise<URL> {
  const finish = await started.browser.get(redirectTo);
  if (finish.res.status !== 303 || !finish.location) throw new Error(`finish failed: ${finish.res.status} ${await finish.res.text()}`);
  const resume = await started.browser.get(finish.location);
  if (resume.res.status !== 303 || !resume.location) throw new Error(`resume failed: ${resume.res.status} ${await resume.res.text()}`);
  return new URL(resume.location);
}

/** The whole happy path: authorize, approve as the owner, return the code and its verifier. */
export async function authorizeAndApprove(h: OAuthHarness, client: Client, o: AuthorizeOptions = {}) {
  const started = await startAuthorization(h, client, o);
  const res = await decide(h, started.uid, 'approve');
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  const { redirectTo } = (await res.json()) as { redirectTo: string };
  const back = await followDecision(started, redirectTo);
  return { back, code: back.searchParams.get('code'), verifier: started.pkce.verifier, started };
}

/** POST /oauth/token, form-encoded, as a public client. */
export async function token(h: OAuthHarness, params: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export async function exchange(h: OAuthHarness, client: Client, code: string, verifier: string) {
  return token(h, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: client.redirect,
    client_id: client.client_id,
    resource: h.resource,
  });
}

export async function refresh(h: OAuthHarness, client: Client, refreshToken: string) {
  return token(h, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id });
}

/** Connect end to end and return the token response. */
export async function connect(h: OAuthHarness, client: Client, o: AuthorizeOptions = {}) {
  const { code, verifier } = await authorizeAndApprove(h, client, o);
  const t = await exchange(h, client, code!, verifier);
  if (t.status !== 200) throw new Error(`token exchange failed: ${t.status} ${JSON.stringify(t.json)}`);
  return t.json as { access_token: string; refresh_token?: string; scope: string; expires_in: number; token_type: string };
}

/** A JSON-RPC `tools/call` against /mcp with a bearer. */
export async function callTool(h: OAuthHarness, name: string, args: Record<string, unknown>, bearer?: string): Promise<Response> {
  return h.post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    bearer ? { authorization: `Bearer ${bearer}` } : {},
  );
}

/** The structured result of a successful tools/call response body. */
export async function toolResult<T = Record<string, unknown>>(res: Response): Promise<{ isError?: boolean; structuredContent?: T; content?: { text: string }[] }> {
  const text = await res.text();
  // Streamable HTTP may answer as an SSE stream with one `data:` line.
  const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
  return json.result;
}
