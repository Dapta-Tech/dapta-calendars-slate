import { describe, it, expect } from 'vitest';
import { LIKELY_BODY_LIMIT_BYTES } from '@slate/types';

import { saveErrorMessage } from './save-error';

const copy = { tooLarge: 'TOO_LARGE', failed: 'FAILED' };

/**
 * The redirect case is the one that matters and the one that cannot be reached
 * from a browser test without an expired session, so it is pinned here with the
 * digest shape Next actually constructs (`NEXT_REDIRECT;<kind>;<dest>;<status>;`).
 *
 * If this regresses, an expired host clicking Save is told their photo is too
 * big and stays on a page they are no longer signed in to.
 */
describe('saveErrorMessage', () => {
  it('re-throws a session redirect instead of reporting it', () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    expect(() => saveErrorMessage(redirect, {}, copy)).toThrow(redirect);
  });

  it('re-throws a redirect to the refresh route too', () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/api/auth/refresh;307;',
    });
    expect(() => saveErrorMessage(redirect, {}, copy)).toThrow(redirect);
  });

  it('reports an ordinary failure as a failure, not as a size problem', () => {
    expect(saveErrorMessage(new Error('boom'), { a: 1 }, copy)).toBe('FAILED');
  });

  it('blames size only when the payload actually is large', () => {
    const big = { avatarUrl: 'x'.repeat(LIKELY_BODY_LIMIT_BYTES + 1) };
    expect(saveErrorMessage(new Error('boom'), big, copy)).toBe('TOO_LARGE');
  });

  it('uses the smallest ceiling in the path, not our own', () => {
    // A proxy refusing at its 1MB default is still a too-large failure, even
    // though the payload is well under the app's 3MB limit.
    const overProxyUnderOurs = { avatarUrl: 'x'.repeat(1_400_000) };
    expect(saveErrorMessage(new Error('boom'), overProxyUnderOurs, copy)).toBe('TOO_LARGE');
  });
});
