import { describe, it, expect } from 'vitest';
import { NoopRateLimiter, RateLimitGuard, TokenBucketRateLimiter, clientKey } from './rate-limit';

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
});
