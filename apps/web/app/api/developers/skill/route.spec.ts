import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readZip } from '@/lib/test/read-zip';

const getSession = vi.fn();
const hostHeaders = vi.fn();
const refreshUpstreamSession = vi.fn();
const setSession = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  hostHeaders: (...a: unknown[]) => hostHeaders(...a),
  refreshUpstreamSession: (...a: unknown[]) => refreshUpstreamSession(...a),
  setSession: (...a: unknown[]) => setSession(...a),
  // admin-api.ts imports these; the route never calls them.
  refreshOrSignOut: vi.fn(),
  signOutKeepingPlace: vi.fn(),
  SessionUnavailableError: class extends Error {},
}));

import { GET } from './route';

/** The pod's own address, as a request reaches it behind a proxy. */
const req = (headers: Record<string, string> = {}) =>
  new NextRequest('https://0.0.0.0:3000/api/developers/skill', { headers });

const INTERNAL_API = 'http://calendars-api.lab.svc.cluster.local:4000';
const PUBLIC_API = 'https://api.calendar.example.com';
const local = { provider: 'local', email: 'alex@example.com' };
const workos = { provider: 'workos', accessToken: 'tok-secret-1', refreshToken: 'refresh-secret-1' };

/**
 * A description no real API has: a zip that lists `GET /v9/widgets` can only
 * have been written from the document the route fetched.
 */
const DOC = {
  openapi: '3.1.0',
  info: { title: 'Fixture', version: '1' },
  servers: [{ url: 'https://hosted.example.com', description: 'Hosted' }],
  components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/v9/widgets': {
      get: { summary: 'List widgets', security: [{ key: [] }], responses: { 200: { description: 'The widgets.' } } },
    },
    '/health': { get: { summary: 'Probe', responses: { 200: { description: 'ok' } } } },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the API answers, per path. Each call takes the next `me` answer, then repeats the last. */
let meAnswers: Array<() => Response | Promise<Response>> = [];
let openapiAnswer: () => Response | Promise<Response> = () => json(DOC);
const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('/v1/me')) return (meAnswers.length > 1 ? meAnswers.shift()! : meAnswers[0]!)();
  if (url.endsWith('/openapi.json')) return openapiAnswer();
  throw new Error(`unexpected fetch ${url}`);
});

const me = (role: string) => () => json({ accountId: 'a1', memberId: 'm1', role, status: 'active' });

describe('GET /api/developers/skill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('API_URL', INTERNAL_API);
    vi.stubEnv('API_PUBLIC_URL', PUBLIC_API);
    vi.stubEnv('MCP_PUBLIC_URL', '');
    vi.stubEnv('PUBLIC_APP_URL', 'https://calendar.example.com');
    vi.stubGlobal('fetch', fetchMock);
    getSession.mockResolvedValue(local);
    hostHeaders.mockResolvedValue({ 'x-slate-email': 'alex@example.com' });
    refreshUpstreamSession.mockResolvedValue({ outcome: 'expired' });
    meAnswers = [me('owner')];
    openapiAnswer = () => json(DOC);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers 401 without a session, and never asks the API', async () => {
    getSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'UNAUTHENTICATED' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 when the API no longer accepts the session', async () => {
    meAnswers = [() => json({ error: 'UNAUTHENTICATED' }, 401)];
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(setSession).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token once, stores it and serves the zip', async () => {
    getSession.mockResolvedValue(workos);
    const fresh = { provider: 'workos', accessToken: 'tok-2', refreshToken: 'r2' };
    refreshUpstreamSession.mockResolvedValue({ outcome: 'refreshed', session: fresh });
    meAnswers = [() => json({}, 401), me('admin')];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(refreshUpstreamSession).toHaveBeenCalledTimes(1);
    expect(setSession).toHaveBeenCalledWith(fresh);
  });

  it('answers 401 when the refreshed token is refused too', async () => {
    getSession.mockResolvedValue(workos);
    refreshUpstreamSession.mockResolvedValue({ outcome: 'refreshed', session: { ...workos, accessToken: 'tok-2' } });
    meAnswers = [() => json({}, 401)];
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(refreshUpstreamSession).toHaveBeenCalledTimes(1);
  });

  it('answers 502, not a sign-out, when the identity service cannot be reached', async () => {
    getSession.mockResolvedValue(workos);
    refreshUpstreamSession.mockResolvedValue({ outcome: 'unavailable' });
    meAnswers = [() => json({}, 401)];
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(setSession).not.toHaveBeenCalled();
  });

  it('answers 403 to a member: the keys page and its download are for owners and admins', async () => {
    meAnswers = [me('member')];
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'FORBIDDEN' });
    // Refused before the API description is even read.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${INTERNAL_API}/v1/me`]);
  });

  it('answers 403 when the API refuses the session its workspace', async () => {
    meAnswers = [() => json({ error: 'FORBIDDEN' }, 403)];
    expect((await GET(req())).status).toBe(403);
  });

  it('answers 502 when the API cannot be reached, rather than pretending the admin is signed out', async () => {
    meAnswers = [() => Promise.reject(new Error('ECONNREFUSED'))];
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'UPSTREAM_UNAVAILABLE' });
  });

  it('answers 502 when the API does not serve a usable description', async () => {
    for (const answer of [() => json({}, 500), () => json({ not: 'openapi' }), () => Promise.reject(new Error('down'))]) {
      openapiAnswer = answer;
      const res = await GET(req());
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: 'OPENAPI_UNAVAILABLE' });
    }
  });

  it('answers 503 busy, passing the wait on, when the API sheds load', async () => {
    meAnswers = [() => new Response('{}', { status: 429, headers: { 'retry-after': '7' } })];
    let res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'UPSTREAM_BUSY' });
    expect(res.headers.get('retry-after')).toBe('7');

    // The same for the description, and with no wait given, none is invented.
    meAnswers = [me('owner')];
    openapiAnswer = () => new Response('{}', { status: 429 });
    res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('gives each upstream call a deadline', async () => {
    await GET(req());
    for (const [url, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.signal, url).toBeInstanceOf(AbortSignal);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when the description is bigger than any real one, declared or streamed', async () => {
    const big = 2 * 1024 * 1024 + 1;
    openapiAnswer = () => new Response('{}', { status: 200, headers: { 'content-length': String(big) } });
    let res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'OPENAPI_TOO_LARGE' });

    openapiAnswer = () => new Response(`{"openapi":"3.1.0","paths":{},"pad":"${'x'.repeat(big)}"}`, { status: 200 });
    res = await GET(req());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'OPENAPI_TOO_LARGE' });
  });

  it('refuses to ship a zip that points nowhere when no public API address is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_PUBLIC_URL', '');
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'API_URL_NOT_CONFIGURED' });
  });

  it('asks the API who the session is, with its identity, on the server-side address', async () => {
    await GET(req());
    expect(fetchMock).toHaveBeenCalledWith(
      `${INTERNAL_API}/v1/me`,
      expect.objectContaining({ headers: { 'x-slate-email': 'alex@example.com' }, cache: 'no-store' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(`${INTERNAL_API}/openapi.json`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('serves the zip, written from the fetched description, with the public addresses in place', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="dapta-calendars-skill.zip"');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    const files = readZip(bytes);
    expect([...files.keys()].sort()).toEqual(
      [
        'dapta-calendars/INSTALL.md',
        'dapta-calendars/SKILL.md',
        'dapta-calendars/reference/endpoints.md',
        'dapta-calendars/reference/mcp-tools.md',
        'dapta-calendars/reference/openapi.json',
      ].sort(),
    );

    // The endpoint reference is the fetched document's, and only its.
    const endpoints = files.get('dapta-calendars/reference/endpoints.md')!;
    expect([...endpoints.matchAll(/^### `(.+)`$/gm)].map((m) => m[1])).toEqual(['GET /v9/widgets', 'GET /health']);
    // The document itself, as served, with servers pointed at this installation.
    const shipped = JSON.parse(files.get('dapta-calendars/reference/openapi.json')!);
    expect(shipped).toEqual({ ...DOC, servers: [{ url: PUBLIC_API, description: 'This installation' }] });

    const skill = files.get('dapta-calendars/SKILL.md')!;
    // The public API and MCP addresses, never the cluster-internal one the server uses.
    expect(skill).toContain(`\`${PUBLIC_API}\``);
    expect(skill).toContain(`\`${PUBLIC_API}/mcp\``);
    for (const [path, content] of files) expect(content, path).not.toContain('svc.cluster.local');
    // The dashboard address is the configured public origin, not the pod's.
    expect(skill).toContain('https://calendar.example.com/admin/developers/keys');
    for (const [path, content] of files) expect(content, path).not.toContain('0.0.0.0');
  });

  it('holds no credential of the person who downloaded it', async () => {
    getSession.mockResolvedValue(workos);
    hostHeaders.mockResolvedValue({ authorization: 'Bearer tok-secret-1' });
    const files = readZip(new Uint8Array(await (await GET(req())).arrayBuffer()));
    for (const [path, content] of files) {
      expect(content, path).not.toContain('tok-secret-1');
      expect(content, path).not.toContain('refresh-secret-1');
    }
  });

  it('serves owners and admins alike', async () => {
    for (const role of ['owner', 'admin']) {
      meAnswers = [me(role)];
      expect((await GET(req())).status, role).toBe(200);
    }
  });

  it('takes the dashboard address from the request when PUBLIC_APP_URL is unset', async () => {
    vi.stubEnv('PUBLIC_APP_URL', '');
    const res = await GET(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'book.example.org' }));
    const skill = readZip(new Uint8Array(await res.arrayBuffer())).get('dapta-calendars/SKILL.md')!;
    expect(skill).toContain('https://book.example.org/admin/developers/keys');
  });
});
