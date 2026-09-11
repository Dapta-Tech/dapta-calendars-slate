import { describe, it, expect } from 'vitest';
import { MAX_REQUEST_BODY, MAX_REQUEST_BODY_BYTES, MAX_INLINE_IMAGE_CHARS } from '@slate/types';

/**
 * `next.config.mjs` writes the Server Action body limit out as a literal
 * instead of importing it, because Next loads that file as bare Node ESM where
 * the workspace packages' extensionless specifiers do not resolve — importing
 * `@slate/types` there makes the dev server refuse to start.
 *
 * So the two numbers are held together here. Drift is otherwise silent until a
 * host with a large stored avatar tries to save and is told to re-upload a
 * photo that was never the problem.
 */
describe('the Server Action body limit', () => {
  it('matches the contract’s ceiling', async () => {
    // Import the config rather than grepping it: a misnest — `serverAction`
    // singular, or the block moved out of `experimental` — leaves the right
    // string in the file while Next silently falls back to its 1MB default.
    const config = (await import('../next.config.mjs')).default;
    expect(config.experimental?.serverActions?.bodySizeLimit).toBe(MAX_REQUEST_BODY);
  });

  it('is big enough for two maxed image fields at once', () => {
    // Which is the whole reason the number is what it is: an avatar and a
    // cover can each hold MAX_INLINE_IMAGE_CHARS, and both ride in one save.
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_INLINE_IMAGE_CHARS * 2);
  });
});
