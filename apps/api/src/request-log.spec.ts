import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { AddressInfo } from 'node:net';
import { annotateRequestAccount, formatPretty, requestLogger, type RequestLogLine } from './request-log';

const EMAIL = 'visitor@example.com';
const TOKEN = 'manage-token-0123456789abcdef';

@Controller('v1')
class FixtureController {
  @Get('bookings/:uid')
  view(@Param('uid') uid: string, @Query('token') token: string) {
    if (token !== TOKEN) throw new HttpException({ error: 'FORBIDDEN', message: 'Bad token.' }, 403);
    return { uid, attendee: { email: EMAIL } };
  }

  @Post('bookings')
  book(@Body() body: { attendee?: { email?: string } }) {
    return { ok: true, echoed: body?.attendee?.email };
  }

  @Get('profiles/:accountCode/:handle')
  profile(@Param('handle') handle: string) {
    return { handle };
  }

  @Get('me')
  me(@Req() req: unknown) {
    annotateRequestAccount(req, 'acct-123');
    return { ok: true };
  }

  @Get('boom')
  boom() {
    throw new Error(`database said: ${EMAIL}`);
  }
}

@Controller('health')
class FixtureHealth {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [FixtureController, FixtureHealth] })
class FixtureModule {}

describe('request log', () => {
  const lines: string[] = [];
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(FixtureModule, { logger: false, bodyParser: false });
    app.use(requestLogger({ format: 'json', write: (l) => lines.push(l) }));
    app.use(json());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    lines.length = 0;
  });

  /** The log is written on `finish`, which can land just after the client sees the body. */
  async function settle(n = 1): Promise<RequestLogLine[]> {
    for (let i = 0; i < 50 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 5));
    return lines.map((l) => JSON.parse(l) as RequestLogLine);
  }

  it('one line per request, with the route template and not the raw path or query', async () => {
    const res = await fetch(`${base}/v1/bookings/uid-42?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const out = await settle();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      level: 'info',
      msg: 'request',
      method: 'GET',
      route: '/v1/bookings/:uid',
      status: 200,
    });
    expect(typeof out[0]!.durationMs).toBe('number');
    expect(out[0]!.requestId).toMatch(/^req_/);
    expect(res.headers.get('x-request-id')).toBe(out[0]!.requestId);
    const raw = lines.join('\n');
    expect(raw).not.toContain('uid-42');
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(EMAIL);
  });

  it('carries the error code of an error body', async () => {
    await fetch(`${base}/v1/bookings/uid-42?token=wrong`);
    const [line] = await settle();
    expect(line).toMatchObject({ status: 403, level: 'warn', code: 'FORBIDDEN' });
  });

  it('never logs a request body, even one carrying an email', async () => {
    const res = await fetch(`${base}/v1/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attendee: { email: EMAIL, name: 'Visitor Name' }, token: TOKEN }),
    });
    expect(res.status).toBe(201);
    const out = await settle();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ method: 'POST', route: '/v1/bookings', status: 201 });
    const raw = lines.join('\n');
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain('Visitor Name');
    expect(raw).not.toContain(TOKEN);
  });

  it('honours a safe x-request-id and replaces an unsafe one', async () => {
    await fetch(`${base}/v1/profiles/acme/alex`, { headers: { 'x-request-id': 'trace-abc.1' } });
    await fetch(`${base}/v1/profiles/acme/alex`, { headers: { 'x-request-id': 'bad id <script>' } });
    const out = await settle(2);
    expect(out[0]!.requestId).toBe('trace-abc.1');
    expect(out[1]!.requestId).toMatch(/^req_/);
  });

  it('names the account: the public code from the route, the id once authenticated', async () => {
    await fetch(`${base}/v1/profiles/acme/alex`);
    await fetch(`${base}/v1/me`);
    const out = await settle(2);
    expect(out[0]).toMatchObject({ route: '/v1/profiles/:accountCode/:handle', account: 'acme' });
    expect(out[0]).not.toHaveProperty('accountId');
    expect(out[1]).toMatchObject({ route: '/v1/me', accountId: 'acct-123' });
  });

  it('a 5xx is level error, and the cause stays out of the line', async () => {
    const res = await fetch(`${base}/v1/boom`);
    expect(res.status).toBe(500);
    const [line] = await settle();
    expect(line).toMatchObject({ status: 500, level: 'error', route: '/v1/boom' });
    expect(lines.join('\n')).not.toContain(EMAIL);
  });

  it('never takes the account from the query string', async () => {
    await fetch(`${base}/v1/bookings/uid-42?token=${TOKEN}&accountCode=secretlookingvalue`);
    const [line] = await settle();
    expect(line).not.toHaveProperty('account');
    expect(lines.join('\n')).not.toContain('secretlookingvalue');
  });

  it('an unmatched path is logged without the path itself', async () => {
    await fetch(`${base}/v1/nothing/${TOKEN}`);
    const [line] = await settle();
    expect(line).toMatchObject({ status: 404, route: '(unmatched)' });
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('skips health probes', async () => {
    await fetch(`${base}/health`);
    await new Promise((r) => setTimeout(r, 30));
    expect(lines).toHaveLength(0);
  });
});

describe('request log: pretty format', () => {
  it('is one readable line with the same fields', () => {
    expect(
      formatPretty({
        ts: '2026-01-01T00:00:00.000Z',
        level: 'warn',
        msg: 'request',
        requestId: 'req_1',
        method: 'POST',
        route: '/v1/reservations',
        status: 400,
        durationMs: 12,
        code: 'INVALID_SLOT',
        account: 'acme',
      }),
    ).toBe('[http] POST /v1/reservations 400 12ms req_1 code=INVALID_SLOT account=acme');
  });
});
