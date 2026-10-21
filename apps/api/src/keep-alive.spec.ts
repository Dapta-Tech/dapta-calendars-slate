import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadServerEnv } from '@slate/config/env';
import { applyKeepAliveTimeout } from './keep-alive';

/**
 * The API must hold an idle keep-alive socket longer than the load balancer in
 * front does (60 s on an AWS ALB), or the balancer can reuse a socket the API
 * is closing and answer with a 502. KEEP_ALIVE_TIMEOUT sets the window; unset
 * or blank, it is 65 s, so a bare fork and a deploy that renders the var empty
 * both boot with a value above the ALB's.
 */
describe('KEEP_ALIVE_TIMEOUT', () => {
  const load = (v?: string) =>
    loadServerEnv({
      NODE_ENV: 'test',
      ...(v === undefined ? {} : { KEEP_ALIVE_TIMEOUT: v }),
    } as NodeJS.ProcessEnv);

  it('defaults to 65 s, and an empty value counts as unset', () => {
    expect(load().KEEP_ALIVE_TIMEOUT).toBe(65_000);
    expect(load('').KEEP_ALIVE_TIMEOUT).toBe(65_000);
  });

  it('carries the configured value, in milliseconds, up to a day', () => {
    expect(load('120000').KEEP_ALIVE_TIMEOUT).toBe(120_000);
    expect(load('86400000').KEEP_ALIVE_TIMEOUT).toBe(86_400_000);
  });

  it('refuses a value that is not a positive whole number, like API_PORT does', () => {
    for (const v of ['0', '-1', '1.5', 'abc']) expect(() => load(v)).toThrow(/KEEP_ALIVE_TIMEOUT/);
  });

  it('refuses more than a day, a typo rather than a balancer setting', () => {
    expect(() => load('86400001')).toThrow(/KEEP_ALIVE_TIMEOUT/);
  });
});

describe('applyKeepAliveTimeout', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.get('/x', (_req, res) => {
      res.json({ ok: true });
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    // After `listen`, the order `main.ts` uses.
    applyKeepAliveTimeout(server, 65_000);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sets the idle window, and a headers deadline above it', () => {
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('a keep-alive answer advertises the window it will hold', async () => {
    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('keep-alive')).toBe('timeout=65');
  });
});
