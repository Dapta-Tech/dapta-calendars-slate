import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { ServerEnv } from '@slate/config/env';
import { CLIENT_IP_HEADER, INTERNAL_SECRET_HEADER, forwardedClient } from '@slate/shared';
import { ENV, RATE_LIMITER } from './tokens';

/**
 * Rate limiting for the unauthenticated public surface (P1-5). The old service
 * had none — public booking/availability/manage were unthrottled, so booking
 * spam and availability scraping were free. This is a pluggable port: the OSS
 * default is an in-process per-IP token bucket; a deployment can disable it or
 * swap a distributed limiter (Redis) behind the same interface in the overlay.
 */
export interface RateLimiter {
  /** Consume one token for `key`. `allowed:false` ⇒ throttle (with retry hint). */
  take(key: string): { allowed: boolean; retryAfterMs: number };
}

/** Never throttles — used when RATE_LIMIT_ENABLED=false. */
export class NoopRateLimiter implements RateLimiter {
  take(_key: string): { allowed: boolean; retryAfterMs: number } {
    return { allowed: true, retryAfterMs: 0 };
  }
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * In-memory token bucket: each key refills at `refillPerSec` up to `capacity`
 * (the burst). Cheap and dependency-free; single-process only (fine for the OSS
 * default — a multi-instance deploy plugs a shared limiter). Idle buckets are
 * pruned when the map grows past a soft cap so memory can't grow unbounded.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private static readonly MAX_KEYS = 50_000;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { allowed: boolean; retryAfterMs: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= TokenBucketRateLimiter.MAX_KEYS) this.prune();
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    }
    // Refill proportional to elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, (t - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const deficit = 1 - b.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((deficit / this.refillPerSec) * 1000) };
  }

  /** Drop fully-refilled (idle) buckets — they carry no state worth keeping. */
  private prune(): void {
    for (const [k, v] of this.buckets) {
      if (v.tokens >= this.capacity) this.buckets.delete(k);
    }
  }
}

export function createRateLimiter(env: ServerEnv): RateLimiter {
  if (!env.RATE_LIMIT_ENABLED) return new NoopRateLimiter();
  return new TokenBucketRateLimiter(env.RATE_LIMIT_CAPACITY, env.RATE_LIMIT_REFILL_PER_SEC);
}

type KeyedRequest = {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
};

/**
 * The client address the limiter keys on.
 *
 * Keying on the first `X-Forwarded-For` entry (as this once did) let any caller
 * send a fresh value per request and never be throttled, so it is the entry the
 * nearest trusted proxy appended (see `forwardedClient`). `trustedHops = 0`, or
 * no header, uses the socket address.
 */
export function clientKey(req: KeyedRequest, trustedHops = 1): string {
  const socket = (req.socket?.remoteAddress || req.ip || 'unknown').toString();
  return forwardedClient(headerOf(req, 'x-forwarded-for'), trustedHops) ?? socket;
}

function headerOf(req: KeyedRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : undefined;
}

/** Constant-time: hashing first makes the compare length-independent too. */
function secretMatches(given: string, secret: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * What a request says about who it is on behalf of.
 *
 * `visitor`: the web app vouched for the address with the internal secret, and
 * it is an IP literal. `forged`: it carried the secret header but the secret was
 * wrong; it is keyed like any public request (no 401, no hint) and only
 * counted. `none`: nothing to act on, keyed as before.
 */
export function vouchedClient(
  req: KeyedRequest,
  secret: string | undefined,
): { kind: 'visitor'; address: string } | { kind: 'forged' } | { kind: 'none' } {
  if (!secret) return { kind: 'none' };
  const given = headerOf(req, INTERNAL_SECRET_HEADER);
  if (given === undefined) return { kind: 'none' };
  if (!secretMatches(given, secret)) return { kind: 'forged' };
  const address = headerOf(req, CLIENT_IP_HEADER)?.trim();
  return address && isIP(address) !== 0 ? { kind: 'visitor', address } : { kind: 'none' };
}

const FORGED_REPORT_MS = 60_000;

/**
 * Applied to the public controller. On throttle it returns 429 with a
 * `Retry-After` header so well-behaved clients back off.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: Pick<ServerEnv, 'RATE_LIMIT_TRUSTED_PROXY_HOPS' | 'INTERNAL_API_SECRET'>,
  ) {}

  private readonly logger = new Logger('RateLimit');
  /** The clock the forged-secret report reads; a field so specs can move it. */
  now: () => number = Date.now;
  // Wrong internal secrets not yet reported: one log line a minute at most,
  // carrying only the count (never an address or the value sent).
  private forged = 0;
  private lastReport = Number.NEGATIVE_INFINITY;

  /** The bucket key: the vouched visitor's address, else the proxy or socket address. */
  keyFor(req: KeyedRequest): string {
    const vouched = vouchedClient(req, this.env.INTERNAL_API_SECRET);
    if (vouched.kind === 'visitor') return vouched.address;
    if (vouched.kind === 'forged') this.countForged();
    return clientKey(req, this.env.RATE_LIMIT_TRUSTED_PROXY_HOPS);
  }

  private countForged(): void {
    this.forged += 1;
    const t = this.now();
    if (t - this.lastReport < FORGED_REPORT_MS) return;
    this.logger.warn(`${this.forged} public request(s) carried a wrong internal secret`);
    this.forged = 0;
    this.lastReport = t;
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const { allowed, retryAfterMs } = this.limiter.take(this.keyFor(req));
    if (!allowed) {
      const res = http.getResponse<{ header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void }>();
      const seconds = Math.ceil(retryAfterMs / 1000).toString();
      res.header?.('Retry-After', seconds);
      res.setHeader?.('Retry-After', seconds);
      throw new HttpException(
        { error: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
