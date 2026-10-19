import { describe, expect, it } from 'vitest';
import { analyticsConfig, hostAnalyticsIdentity, isInternalViewer } from './config';

const env = (over: Record<string, string> = {}) => ({ NODE_ENV: 'test', ...over }) as NodeJS.ProcessEnv;
const ME = { email: 'Host@Example.test', memberId: 'm1', accountShortCode: 'abc123', role: 'owner' };

describe('analyticsConfig', () => {
  it('is off with nothing set, and reads the runtime names, never NEXT_PUBLIC ones', () => {
    expect(analyticsConfig(env())).toBeNull();
    expect(
      analyticsConfig(env({ NEXT_PUBLIC_PRODUCT_ANALYTICS_KEY: 'phc_x', PRODUCT_ANALYTICS_PROVIDER: 'posthog' })),
    ).toBeNull();
    expect(
      analyticsConfig(
        env({
          PRODUCT_ANALYTICS_PROVIDER: 'posthog',
          PRODUCT_ANALYTICS_KEY: 'phc_x',
          PRODUCT_ANALYTICS_HOST: 'https://e.example.test/',
        }),
      ),
    ).toEqual({ provider: 'posthog', key: 'phc_x', host: 'https://e.example.test' });
  });
});

describe('hostAnalyticsIdentity', () => {
  it('takes the immutable short code as the account key and decides internal on the server', () => {
    expect(hostAnalyticsIdentity(ME, undefined, env({ PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'example.test' }))).toEqual({
      email: 'Host@Example.test',
      memberId: 'm1',
      accountKey: 'abc123',
      role: 'owner',
      isInternal: true,
      landingId: null,
    });
    expect(isInternalViewer('host@customer.io', env({ PRODUCT_ANALYTICS_INTERNAL_EMAILS: 'example.test' }))).toBe(false);
  });

  it('keeps a well-formed landing id and refuses anything else', () => {
    expect(hostAnalyticsIdentity(ME, '0198a1b2-c3d4', env())?.landingId).toBe('0198a1b2-c3d4');
    expect(hostAnalyticsIdentity(ME, '<script>', env())?.landingId).toBeNull();
  });

  it('is null without an email, rather than invent an id', () => {
    expect(hostAnalyticsIdentity({ ...ME, email: null }, undefined, env())).toBeNull();
  });
});
