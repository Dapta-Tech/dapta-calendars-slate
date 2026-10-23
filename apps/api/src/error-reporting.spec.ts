import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { loadServerEnv } from '@slate/config/env';
import { ANALYTICS_GROUP_TYPE, type ErrorReport, type ErrorReporter } from '@slate/shared';
import { PosthogAnalyticsProvider, type AnalyticsProvider } from './analytics.provider';
import { CalV2ExceptionFilter, CalV2RequestIdInterceptor } from './cal-v2.controller';
import {
  ErrorReportingFilter,
  createApiErrorReporter,
  installProcessErrorHooks,
  reportRequestError,
} from './error-reporting';
import { annotateRequestInternal, requestLogger } from './request-log';
import { ERROR_REPORTER } from './tokens';

/**
 * Error tracking, the API half: what is reported (a 5xx, anything unhandled,
 * a crash), what is not (a handled 4xx), what a report carries about its
 * request, and that the answer a client gets is exactly Nest's own.
 */

const EMAIL = 'ana.visitor@example.com';
const PHONE = '+57 300 123 4567';

/** A provider that records the errors it was handed. */
function recordingProvider(): AnalyticsProvider & { errors: ErrorReport[] } {
  const errors: ErrorReport[] = [];
  return {
    name: 'recording',
    errors,
    capture: async () => undefined,
    updateAccount: async () => undefined,
    captureException: async (report) => void errors.push(report),
  };
}

const env = (over: Record<string, string> = {}) =>
  loadServerEnv({ NODE_ENV: 'test', PUBLIC_APP_URL: 'https://cal.example.test', ...over } as NodeJS.ProcessEnv);

/** Drain a reporter whose sends are scheduled on the next turn. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('createApiErrorReporter', () => {
  it('is null with analytics off, with errors switched off, and for a provider that takes no errors', () => {
    expect(createApiErrorReporter(env(), null)).toBeNull();
    expect(createApiErrorReporter(env({ PRODUCT_ANALYTICS_ERRORS: 'off' }), recordingProvider())).toBeNull();
    expect(createApiErrorReporter(env({ PRODUCT_ANALYTICS_ERRORS: 'nope' }), recordingProvider())).toBeNull();
    const { captureException: _drop, ...productOnly } = recordingProvider();
    expect(createApiErrorReporter(env(), productOnly)).toBeNull();
  });

  it('reports through the provider, tagged with its surface and the public host', async () => {
    const provider = recordingProvider();
    const reporter = createApiErrorReporter(env({ PRODUCT_ANALYTICS_ERRORS: 'ON' }), provider)!;
    reporter.report(new Error(`no row for ${EMAIL}`));
    await settle();
    expect(provider.errors).toHaveLength(1);
    expect(provider.errors[0]).toMatchObject({
      properties: { surface: 'api', $host: 'cal.example.test' },
      exceptions: [{ type: 'Error', value: 'no row for [email]' }],
    });
  });

  it("names the configured public API host; without one, a request's public Host, never an internal one", () => {
    const report = vi.fn();
    const withApiHost = createApiErrorReporter(env({ API_PUBLIC_URL: 'https://api.example.test' }), recordingProvider())!;
    expect(withApiHost.useRequestHost).toBe(false);
    reportRequestError({ ...withApiHost, report }, new Error('x'), { headers: { host: 'localhost:4000' }, method: 'GET' });
    expect(report.mock.calls[0]![1].properties).not.toHaveProperty('$host');

    const without = createApiErrorReporter(env(), recordingProvider())!;
    expect(without.useRequestHost).toBe(true);
    for (const [hostHeader, expected] of [
      ['localhost:4411', 'localhost:4411'],
      ['api.example.test', 'api.example.test'],
      ['calendars-api.lab.svc.cluster.local', undefined],
      ['10.2.3.4:4000', undefined],
    ] as const) {
      report.mockClear();
      reportRequestError({ ...without, report }, new Error('x'), { headers: { host: hostHeader }, method: 'GET' });
      expect([hostHeader, report.mock.calls[0]![1].properties['$host']]).toEqual([hostHeader, expected]);
    }
  });
});

describe('PosthogAnalyticsProvider.captureException', () => {
  it('posts one $exception to the capture endpoint, filed under the process, with no person', async () => {
    const provider = new PosthogAnalyticsProvider(
      { provider: 'posthog', key: 'phc_test', host: 'https://ingest.example.test', errors: true },
      ANALYTICS_GROUP_TYPE,
    );
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    provider.fetchImpl = fetchImpl as unknown as typeof fetch;
    await provider.captureException({
      uuid: 'u-1',
      timestamp: 0,
      exceptions: [{ type: 'Error', value: 'boom', frames: [] }],
      handled: false,
      mechanism: 'filter',
      count: 1,
      properties: { route: '/v1/x', status: 500 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ingest.example.test/capture/');
    expect(JSON.parse(init.body as string)).toMatchObject({
      api_key: 'phc_test',
      event: '$exception',
      distinct_id: 'calendars-api',
      uuid: 'u-1',
      properties: { route: '/v1/x', status: 500, $process_person_profile: false, $exception_list: [{ value: 'boom' }] },
    });
  });
});

@Controller('v1')
class FixtureController {
  @Get('profiles/:accountCode/boom')
  boom(@Param('accountCode') _code: string, @Req() req: unknown) {
    annotateRequestInternal(req, true);
    throw new Error(`database said: ${EMAIL}, ${PHONE}`);
  }

  @Post('webhooks')
  unavailable() {
    throw new ServiceUnavailableException({ error: 'INTEGRATION_KEY_MISSING', message: 'no key' });
  }

  @Get('handled/:kind')
  handled(@Param('kind') kind: string) {
    if (kind === 'bad') throw new BadRequestException({ error: 'BAD_REQUEST' });
    if (kind === 'auth') throw new UnauthorizedException();
    if (kind === 'limit') throw new HttpException({ error: 'RATE_LIMITED' }, 429);
    throw new NotFoundException();
  }
}

@UseInterceptors(CalV2RequestIdInterceptor)
@UseFilters(CalV2ExceptionFilter)
@Controller('v2')
class FixtureV2Controller {
  @Get('boom')
  boom() {
    throw new Error(`v2 broke for ${EMAIL}`);
  }
}

describe('the global filter and the v2 filter, in a real app', () => {
  const provider = recordingProvider();
  const reporter = createApiErrorReporter(env(), provider)!;
  let app: NestExpressApplication;
  let base: string;

  @Module({
    controllers: [FixtureController, FixtureV2Controller],
    providers: [
      { provide: ERROR_REPORTER, useValue: reporter },
      { provide: APP_FILTER, useClass: ErrorReportingFilter },
      CalV2RequestIdInterceptor,
    ],
  })
  class FixtureModule {}

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(FixtureModule, { logger: false, bodyParser: false });
    app.use(requestLogger({ format: 'json', write: () => undefined }));
    app.use(json());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    provider.errors.length = 0;
  });

  it('a 500 is reported with its route template, method, status, request id and account, scrubbed', async () => {
    const res = await fetch(`${base}/v1/profiles/acme/boom?email=${encodeURIComponent(EMAIL)}`, {
      headers: { 'x-request-id': 'req_e2e_1', cookie: `session=${EMAIL}` },
    });
    // The answer is Nest's own, unchanged.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    await settle();
    expect(provider.errors).toHaveLength(1);
    const [report] = provider.errors;
    expect(report).toMatchObject({
      handled: false,
      mechanism: 'filter',
      properties: {
        surface: 'api',
        $host: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
        route: '/v1/profiles/:accountCode/boom',
        method: 'GET',
        status: 500,
        request_id: 'req_e2e_1',
        account_code: 'acme',
        is_internal: true,
      },
      exceptions: [{ type: 'Error', value: 'database said: [email], [phone]' }],
    });
    // Frames point at this TypeScript file, in app.
    const top = report!.exceptions[0]!.frames.at(-1)!;
    expect(top.filename).toMatch(/error-reporting\.spec\.ts$/);
    expect(top.in_app).toBe(true);
    // Nothing of the request beyond the context: no path value, query, header or cookie.
    const sent = JSON.stringify(report);
    expect(sent).not.toContain(EMAIL);
    expect(sent).not.toContain('session=');
    expect(sent).not.toContain('300 123');
  });

  it('a deliberate 503 is a 5xx and is reported; its body is still the coded one', async () => {
    const res = await fetch(`${base}/v1/webhooks`, { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'INTEGRATION_KEY_MISSING' });
    await settle();
    expect(provider.errors.map((r) => [r.properties['route'], r.properties['status']])).toEqual([['/v1/webhooks', 503]]);
  });

  it('a handled 4xx (validation, auth, rate limit, not found, an unmatched route) is never reported', async () => {
    for (const path of ['/v1/handled/bad', '/v1/handled/auth', '/v1/handled/limit', '/v1/handled/missing', '/v1/nothing-here']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    await settle();
    expect(provider.errors).toEqual([]);
  });

  it('the v2 surface reports from its own filter, with the request id it gave the caller', async () => {
    const res = await fetch(`${base}/v2/boom`, { headers: { 'x-request-id': 'req_v2_1' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', requestId: 'req_v2_1' } });
    await settle();
    expect(provider.errors).toHaveLength(1);
    expect(provider.errors[0]).toMatchObject({
      properties: { route: '/v2/boom', method: 'GET', status: 500, request_id: 'req_v2_1' },
      exceptions: [{ value: 'v2 broke for [email]' }],
    });
  });
});

describe('the filters with error tracking off', () => {
  it('answer exactly as before and report nothing', async () => {
    @Module({
      controllers: [FixtureController],
      providers: [
        { provide: ERROR_REPORTER, useFactory: () => createApiErrorReporter(env(), null) },
        { provide: APP_FILTER, useClass: ErrorReportingFilter },
      ],
    })
    class OffModule {}
    const app = await NestFactory.create<NestExpressApplication>(OffModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      expect(app.get(ERROR_REPORTER, { strict: false })).toBeNull();
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/acme/boom`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    } finally {
      await app.close();
    }
  });

  it('reportRequestError is a no-op without a reporter', () => {
    expect(() => reportRequestError(null, new Error('x'), {})).not.toThrow();
  });
});

describe('installProcessErrorHooks', () => {
  function fakeProcess() {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const logs: unknown[] = [];
    return { proc, exit, logs, log: (m: string, e: unknown) => void logs.push([m, e]) };
  }

  it('an uncaught exception is reported, then the process still exits with 1, once', async () => {
    const provider = recordingProvider();
    const reporter = createApiErrorReporter(env(), provider)!;
    const p = fakeProcess();
    const undo = installProcessErrorHooks(reporter, { proc: p.proc as unknown as NodeJS.Process, exit: p.exit, log: p.log, flushMs: 200 });
    p.proc.emit('uncaughtException', new Error(`crash for ${EMAIL}`));
    p.proc.emit('uncaughtException', new Error('second crash'));
    await vi.waitFor(() => expect(p.exit).toHaveBeenCalledWith(1));
    expect(p.exit).toHaveBeenCalledTimes(1);
    expect(provider.errors[0]).toMatchObject({ handled: false, mechanism: 'uncaught_exception', exceptions: [{ value: 'crash for [email]' }] });
    expect(p.logs).toHaveLength(1);
    undo();
    expect(p.proc.listenerCount('uncaughtException')).toBe(0);
    expect(p.proc.listenerCount('unhandledRejection')).toBe(0);
  });

  it('an unhandled rejection is reported as one and ends the process as Node would', async () => {
    const provider = recordingProvider();
    const reporter = createApiErrorReporter(env(), provider)!;
    const p = fakeProcess();
    installProcessErrorHooks(reporter, { proc: p.proc as unknown as NodeJS.Process, exit: p.exit, log: p.log, flushMs: 200 });
    p.proc.emit('unhandledRejection', 'rejected with a plain string');
    await vi.waitFor(() => expect(p.exit).toHaveBeenCalledWith(1));
    expect(provider.errors[0]).toMatchObject({
      mechanism: 'unhandled_rejection',
      exceptions: [{ type: 'string', value: 'rejected with a plain string' }],
    });
  });

  it('a provider that never answers cannot keep a crashed process alive', async () => {
    const reporter: ErrorReporter = {
      stats: { sent: 0, folded: 0, dropped: 0 },
      report: () => undefined,
      flush: () => new Promise<void>(() => undefined),
    };
    const p = fakeProcess();
    installProcessErrorHooks(reporter, { proc: p.proc as unknown as NodeJS.Process, exit: p.exit, log: p.log, flushMs: 10 });
    p.proc.emit('uncaughtException', new Error('x'));
    await vi.waitFor(() => expect(p.exit).toHaveBeenCalledWith(1), { timeout: 3_000 });
  });
});
