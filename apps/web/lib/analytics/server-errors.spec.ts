import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportRequestError, resetWebServerErrorsForTests, webServerErrorReporter } from './server-errors';

/**
 * The web server's half of error tracking (`onRequestError` in
 * instrumentation.ts): what a report says about the failed request, and what
 * it never carries (the path, its query, a header, a cookie).
 */

const EMAIL = 'ana.visitor@example.com';

const ON = {
  NODE_ENV: 'test',
  PRODUCT_ANALYTICS_PROVIDER: 'posthog',
  PRODUCT_ANALYTICS_KEY: 'phc_test',
  PRODUCT_ANALYTICS_HOST: 'https://ingest.example.test',
  PUBLIC_APP_URL: 'https://cal.example.test',
} as unknown as NodeJS.ProcessEnv;

const request = (path = `/acme/ana/intro?prefill=${encodeURIComponent(EMAIL)}`) => ({
  path,
  method: 'GET',
  headers: {
    host: 'App.Example.Test',
    'x-request-id': 'req_web_1',
    cookie: `session=${EMAIL}`,
    authorization: 'Bearer secret',
  },
});

const RENDER = { routePath: '/[accountCode]/[handle]/[slug]', routeType: 'render', renderSource: 'react-server-components' };

let fetchMock: ReturnType<typeof vi.fn>;
const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  resetWebServerErrorsForTests();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reportRequestError', () => {
  it('sends one scrubbed $exception with the route template, method, status, request id and account', async () => {
    const error = Object.assign(new Error(`API /v1/profiles/acme/ana?email=${EMAIL} failed: 500 for ${EMAIL}`), { digest: '4242' });
    reportRequestError(error, request(), RENDER, ON);
    expect(fetchMock).not.toHaveBeenCalled();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://ingest.example.test/capture/');
    const [body] = bodies();
    expect(body).toMatchObject({
      api_key: 'phc_test',
      event: '$exception',
      distinct_id: 'calendars-web-server',
      properties: {
        product: 'calendars',
        surface: 'next_server',
        $host: 'app.example.test',
        route: '/[accountCode]/[handle]/[slug]',
        method: 'GET',
        status: 500,
        request_id: 'req_web_1',
        route_type: 'render',
        render_source: 'react-server-components',
        digest: '4242',
        account_code: 'acme',
        $process_person_profile: false,
        $exception_list: [{ type: 'Error', value: 'API /v1/profiles/acme/ana failed: 500 for [email]' }],
      },
    });
    const sent = JSON.stringify(body);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain('prefill');
    expect(sent).not.toContain('session=');
    expect(sent).not.toContain('Bearer');
    expect(sent).not.toContain('/acme/ana/intro');
  });

  it('counts repeats of one failure instead of dropping them: sent once now, the rest folded into a count', async () => {
    const failing = () => Object.assign(new Error('boom'), { digest: 'same', stack: 'Error: boom\n    at load (/srv/app/lib/api.ts:81:9)' });
    for (let i = 0; i < 3; i++) reportRequestError(failing(), request(), RENDER, ON);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((bodies()[0]!['properties'] as Record<string, unknown>)['count']).toBe(1);
    // The other two wait for the minute to close, then leave as one event with `count: 2`.
    await webServerErrorReporter(ON)!.flush(100);
    expect(bodies().map((b) => (b['properties'] as Record<string, unknown>)['count'])).toEqual([1, 2]);
  });

  it('names the public host the request came to, never an internal one, else the configured app host', async () => {
    for (const [hostHeader, expected] of [
      ['localhost:3411', 'localhost:3411'],
      ['10.0.12.7:3000', 'cal.example.test'],
      ['calendars-web.lab.svc.cluster.local', 'cal.example.test'],
      [undefined, 'cal.example.test'],
      ['evil.example.test/../x', 'cal.example.test'],
    ] as const) {
      resetWebServerErrorsForTests();
      fetchMock.mockClear();
      reportRequestError(new Error(String(hostHeader)), { path: '/admin', method: 'GET', headers: { host: hostHeader } }, {
        routePath: '/admin',
        routeType: 'render',
      }, ON);
      await settle();
      expect([hostHeader, (bodies()[0]!['properties'] as Record<string, unknown>)['$host']]).toEqual([hostHeader, expected]);
    }
  });

  it('names an account only on a public route, and mints a request id when none is safe', async () => {
    reportRequestError(new Error('a'), { path: '/admin/bookings', method: 'POST', headers: { 'x-request-id': EMAIL } }, {
      routePath: '/admin/bookings',
      routeType: 'action',
    }, ON);
    await settle();
    const props = bodies()[0]!['properties'] as Record<string, unknown>;
    expect(props).not.toHaveProperty('account_code');
    expect(props['route_type']).toBe('action');
    expect(String(props['request_id'])).toMatch(/^req_/);
    expect(JSON.stringify(props)).not.toContain(EMAIL);
  });

  it('sends nothing with analytics off or errors switched off, and never throws', async () => {
    reportRequestError(new Error('x'), request(), RENDER, { NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv);
    resetWebServerErrorsForTests();
    reportRequestError(new Error('y'), request(), RENDER, { ...ON, PRODUCT_ANALYTICS_ERRORS: 'off' });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(webServerErrorReporter({ ...ON, PRODUCT_ANALYTICS_ERRORS: 'off' })).toBeNull();
    expect(() => reportRequestError(new Error('z'), null as never, null as never, ON)).not.toThrow();
  });

  it('a provider that is down costs the request nothing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(() => reportRequestError(new Error('x'), request(), RENDER, ON)).not.toThrow();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
