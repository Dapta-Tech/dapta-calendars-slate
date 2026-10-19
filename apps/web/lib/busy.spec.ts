import { describe, expect, it } from 'vitest';
import { ApiBusyError, DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS, isBusy, orBusy, retryAfterMsOf } from './busy';

describe('Retry-After, as the web reads it', () => {
  it('reads delta-seconds and HTTP dates, and clamps both', () => {
    expect(retryAfterMsOf('1')).toBe(1000);
    expect(retryAfterMsOf(' 2.5 ')).toBe(2500);
    expect(retryAfterMsOf('0')).toBe(0);
    expect(retryAfterMsOf('3600')).toBe(MAX_RETRY_AFTER_MS);
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(retryAfterMsOf('Sun, 18 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    expect(retryAfterMsOf('Sun, 18 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('absent or unreadable: a short default, never zero and never forever', () => {
    expect(retryAfterMsOf(null)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMsOf('')).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(retryAfterMsOf('soon')).toBe(DEFAULT_RETRY_AFTER_MS);
  });
});

describe('orBusy', () => {
  it('turns a busy API into a marker the page renders, and passes values through', async () => {
    expect(await orBusy(Promise.resolve(7))).toBe(7);
    const busy = await orBusy(Promise.reject(new ApiBusyError(3000)));
    expect(isBusy(busy)).toBe(true);
    expect(busy).toEqual({ busy: true, retryAfterMs: 3000 });
  });

  it('rethrows every other failure untouched (Next redirect and not-found signals included)', async () => {
    const signal = Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    await expect(orBusy(Promise.reject(signal))).rejects.toBe(signal);
    await expect(orBusy(Promise.reject(new Error('API failed: 500')))).rejects.toThrow('500');
  });
});
