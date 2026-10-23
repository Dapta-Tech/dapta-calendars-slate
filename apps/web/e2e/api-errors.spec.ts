import { expect, test } from '@playwright/test';
import { E2E, HOST, waitForAnalytics, type RecordedAnalytics } from './stack';

/**
 * Error tracking, the API's half, end to end: a route that answers 5xx is
 * reported by the API itself to the stand-in ingestion host, with the product,
 * surface and public host every error carries, its route template and request
 * id, and frames that point at TypeScript lines. Once, after both browser runs
 * (the `api` project): the reporter counts a repeat of the same error within a
 * minute instead of sending it again.
 */

type Entry = { type: string; mechanism: Record<string, unknown>; stacktrace: { frames: Array<Record<string, unknown>> } };
const entries = (e: RecordedAnalytics) => (e.properties?.['$exception_list'] ?? []) as Entry[];

test('an API route that fails is reported by the API, with its route, request id and TypeScript frames', async ({ request }) => {
  const since = Date.now();
  // No INTEGRATION_ENCRYPTION_KEY in the suite: the API refuses to store a
  // webhook secret with a coded 503, a 5xx like any other.
  const res = await request.post(`${E2E.api}/v1/webhooks`, {
    headers: { 'x-slate-email': HOST.email, 'x-request-id': 'req_e2e_errors_api' },
    data: { subscriberUrl: 'https://1.1.1.1/hook', eventTriggers: ['BOOKING_CREATED'] },
  });
  expect(res.status()).toBe(503);
  expect(res.headers()['x-request-id']).toBe('req_e2e_errors_api');

  const api = await waitForAnalytics(
    (e) => e.event === '$exception' && e.source === 'server' && e.properties?.['request_id'] === 'req_e2e_errors_api',
    since,
  );
  // No public API address is configured in the suite, so the deployment's
  // public app address names it (from configuration, never a request's Host).
  expect(api.properties).toMatchObject({ product: 'calendars', surface: 'api', $host: `localhost:${E2E.webPort}` });
  expect(api.distinct_id).toBe('calendars-api');
  expect(api.properties).toMatchObject({
    route: '/v1/webhooks',
    method: 'POST',
    status: 503,
    is_internal: false,
    $process_person_profile: false,
  });
  const [entry] = entries(api);
  expect(entry).toMatchObject({ type: 'ServiceUnavailableException', mechanism: { type: 'filter', handled: false } });
  // Readable: the failing frame is a line of the API's TypeScript source.
  const top = [...entry!.stacktrace.frames].reverse().find((f) => f['in_app'] === true)!;
  expect(String(top['filename'])).toMatch(/^src\/.+\.ts$/);
  expect(typeof top['lineno']).toBe('number');
  expect(JSON.stringify(api)).not.toContain(HOST.email);
});
