import { describe, it, expect } from 'vitest';
import { NoopRateLimiter, RateLimitGuard, TokenBucketRateLimiter, clientKey, vouchedClient } from './rate-limit';

describe('rate limiting (P1-5)', () => {
  it('allows a burst up to capacity, then throttles with a retry hint', () => {
    const now = 1_000_000;
    const rl = new TokenBucketRateLimiter(3, 1, () => now); // burst 3, 1/sec
    expect(rl.take('ip').allowed).toBe(true);
    expect(rl.take('ip').allowed).toBe(true);
    expect(rl.take('ip').allowed).toBe(true);
    const denied = rl.take('ip');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter(1, 1, () => now); // 1 token, 1/sec
    expect(rl.take('ip').allowed).toBe(true);
    expect(rl.take('ip').allowed).toBe(false);
    now += 1000; // one second → one token back
    expect(rl.take('ip').allowed).toBe(true);
  });

  it('is per-key: one client cannot exhaust another', () => {
    const now = 0;
    const rl = new TokenBucketRateLimiter(1, 1, () => now);
    expect(rl.take('a').allowed).toBe(true);
    expect(rl.take('a').allowed).toBe(false);
    // A different IP still has its full bucket.
    expect(rl.take('b').allowed).toBe(true);
  });

  it('noop limiter never throttles (RATE_LIMIT_ENABLED=false)', () => {
    const rl = new NoopRateLimiter();
    for (let i = 0; i < 1000; i++) expect(rl.take('ip').allowed).toBe(true);
  });

  describe('client key behind proxies', () => {
    const req = (xff?: string | string[], socket = '10.0.0.5') => ({
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      socket: { remoteAddress: socket },
    });

    it('one trusted hop: the entry the load balancer appended, not what the client sent', () => {
      expect(clientKey(req('203.0.113.7'), 1)).toBe('203.0.113.7');
      expect(clientKey(req('1.1.1.1, 203.0.113.7'), 1)).toBe('203.0.113.7');
      expect(clientKey(req('9.9.9.9, 8.8.8.8, 203.0.113.7'), 1)).toBe('203.0.113.7');
    });

    it('two trusted hops (CDN + load balancer): the address the CDN saw', () => {
      expect(clientKey(req('1.1.1.1, 203.0.113.7, 198.51.100.2'), 2)).toBe('203.0.113.7');
    });

    it('fewer entries than hops: the leftmost; no header or zero hops: the socket', () => {
      expect(clientKey(req('203.0.113.7'), 2)).toBe('203.0.113.7');
      expect(clientKey(req(undefined), 1)).toBe('10.0.0.5');
      expect(clientKey(req('1.1.1.1, 203.0.113.7'), 0)).toBe('10.0.0.5');
    });

    it('a repeated header is read as one list', () => {
      expect(clientKey(req(['1.1.1.1', '203.0.113.7']), 1)).toBe('203.0.113.7');
    });

    it('rotating the client-supplied part no longer escapes the bucket', () => {
      const now = 0;
      const guard = new RateLimitGuard(new TokenBucketRateLimiter(2, 1, () => now), {
        RATE_LIMIT_TRUSTED_PROXY_HOPS: 1,
      });
      const ctx = (spoof: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => req(`${spoof}, 203.0.113.7`),
            getResponse: () => ({ setHeader: () => undefined }),
          }),
        }) as never;
      expect(guard.canActivate(ctx('1.0.0.1'))).toBe(true);
      expect(guard.canActivate(ctx('1.0.0.2'))).toBe(true);
      expect(() => guard.canActivate(ctx('1.0.0.3'))).toThrow();
    });
  });

  describe('a visitor address vouched for by the web app', () => {
    // A stand-in, at the 32-character minimum the API accepts.
    const SECRET = 'test-secret-'.padEnd(32, 'x');
    const req = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: '10.0.0.5' } });

    it('is trusted with the matching secret and an IPv4 or IPv6 literal', () => {
      const ok = (ip: string) => vouchedClient(req({ 'x-slate-internal': SECRET, 'x-slate-client-ip': ip }), SECRET);
      expect(ok('203.0.113.7')).toEqual({ kind: 'visitor', address: '203.0.113.7' });
      expect(ok(' 2001:db8::7 ')).toEqual({ kind: 'visitor', address: '2001:db8::7' });
    });

    it('is ignored when the feature is off, the secret is wrong or absent, or the address is not a literal', () => {
      const h = { 'x-slate-internal': SECRET, 'x-slate-client-ip': '203.0.113.7' };
      expect(vouchedClient(req(h), undefined)).toEqual({ kind: 'none' });
      expect(vouchedClient(req({ ...h, 'x-slate-internal': 'wrong' }), SECRET)).toEqual({ kind: 'forged' });
      expect(vouchedClient(req({ 'x-slate-client-ip': '203.0.113.7' }), SECRET)).toEqual({ kind: 'none' });
      for (const bad of ['', 'example.com', '203.0.113.7, 1.1.1.1', '999.1.1.1']) {
        expect(vouchedClient(req({ ...h, 'x-slate-client-ip': bad }), SECRET)).toEqual({ kind: 'none' });
      }
    });

    it('keys the bucket on it; a wrong secret keys like any request and is reported once a minute', () => {
      const guard = new RateLimitGuard(new NoopRateLimiter(), {
        RATE_LIMIT_TRUSTED_PROXY_HOPS: 1,
        INTERNAL_API_SECRET: SECRET,
      });
      let now = 0;
      guard.now = () => now;
      const warned: string[] = [];
      (guard as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m) => warned.push(m);
      expect(guard.keyFor(req({ 'x-slate-internal': SECRET, 'x-slate-client-ip': '203.0.113.7' }))).toBe('203.0.113.7');
      const forged = req({ 'x-slate-internal': 'wrong', 'x-slate-client-ip': '203.0.113.7' });
      for (let i = 0; i < 5; i++) expect(guard.keyFor(forged)).toBe('10.0.0.5');
      now += 60_000;
      guard.keyFor(forged);
      expect(warned).toEqual([
        '1 public request(s) carried a wrong internal secret',
        '5 public request(s) carried a wrong internal secret',
      ]);
    });
  });
});
