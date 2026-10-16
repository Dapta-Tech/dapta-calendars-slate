import { describe, expect, it } from 'vitest';
import { loadServerEnv } from '@slate/config/env';

/**
 * F10: the support address booking emails name is the deployment's, set by
 * MAIL_SUPPORT_EMAIL. Unset is the bare-fork default and prints no line; no
 * value, empty or malformed, may stop the API from booting.
 */
describe('MAIL_SUPPORT_EMAIL', () => {
  const load = (v?: string) =>
    loadServerEnv({
      NODE_ENV: 'test',
      ...(v === undefined ? {} : { MAIL_SUPPORT_EMAIL: v }),
    } as NodeJS.ProcessEnv);

  it('is unset by default, and an empty value counts as unset', () => {
    expect(load().MAIL_SUPPORT_EMAIL).toBeUndefined();
    expect(load('').MAIL_SUPPORT_EMAIL).toBeUndefined();
  });

  it('carries the configured address', () => {
    expect(load('help@example.com').MAIL_SUPPORT_EMAIL).toBe('help@example.com');
  });

  it('never refuses to boot on a malformed value (the renderer drops it)', () => {
    expect(() => load('not an address')).not.toThrow();
  });
});
