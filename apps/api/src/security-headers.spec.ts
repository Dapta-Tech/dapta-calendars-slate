import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { securityHeaders } from './security-headers';

describe('security headers', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.get('/x', (_req, res) => {
      res.json({ ok: true });
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sets nosniff, no-referrer and DENY, and drops X-Powered-By, on answers and 404s alike', async () => {
    for (const path of ['/x', '/missing']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});
