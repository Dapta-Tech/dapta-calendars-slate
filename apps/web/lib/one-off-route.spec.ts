import { describe, expect, it } from 'vitest';
import { frameAncestorsFor } from './framing';
import { isProductPath } from './theme';
import { isEmbedRequest, parseEmbedParams, searchParamsFromQuery } from './embed';

/**
 * The routing claims `/booking/{token}` rests on (#69 / AB2, #110).
 *
 * The page's own header comment argues that a dedicated top-level route is the
 * only shape that can give a guessed token a real 404, and that argument leans
 * on three properties of this repo. An argument in a comment is worth nothing
 * once somebody edits the list it depends on, so the two that live in THIS
 * package are pinned here.
 *
 * The third — that no account can ever claim `booking` as a code, vanity slug
 * or alias, which is what stops this route shadowing a real booking page — is
 * pinned in `packages/engine/src/one-off-link.spec.ts`, next to the blocklist
 * it asserts on. `apps/web` does not depend on `@slate/engine` and a test is
 * not a reason to make it, exactly as `framing.spec.ts` says one file over.
 * The path is therefore spelled literally below; `oneOffLinkPath` in the engine
 * owns the real definition.
 */
describe('/booking/{token} — the shape the 404 depends on', () => {
  const TOKEN = 'x'.repeat(43);
  const PATH = `/booking/${TOKEN}`;

  /**
   * Claim: `?embed=1` still works, because this route is not the product.
   *
   * `isProductPath` drives BOTH the canvas the root layout paints on and, since
   * #67, `frame-ancestors`. If `/booking` ever landed in `PRODUCT_PREFIXES`, an
   * invite link pasted into a host's own site would render a blocked frame with
   * no error anywhere — the exact silent failure that list's comment warns
   * about, and nothing on screen in the admin would show it.
   */
  it('stays on the public canvas and stays frameable', () => {
    expect(isProductPath(PATH)).toBe(false);
    expect(frameAncestorsFor(PATH)).toBe('*');
  });

  it('reads embed mode and appearance overrides exactly as a public route does', () => {
    const query = searchParamsFromQuery('embed=1&theme=dark&brand_color=1a73e8');
    expect(isEmbedRequest(query)).toBe(true);
    const mode = parseEmbedParams(query);
    expect(mode.embed).toBe(true);
    expect(mode.style.theme).toBe('dark');
    expect(mode.brandColor).toBe('#1a73e8');
  });

  /**
   * Claim: the canonical-account-code 308 cannot fire here.
   *
   * The two public booking routes carry their whole query through
   * `withSearchParams` on that redirect, because an alias-coded embed would
   * otherwise 308 into a full-chrome page inside the frame. This path has no
   * account code in it at all, so the redirect has nothing to rewrite — the
   * hazard is absent rather than handled, which is why the route needs no
   * `withSearchParams` call of its own.
   */
  it('carries no account code, so there is no alias for a 308 to canonicalise', () => {
    const segments = PATH.split('/').filter(Boolean);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe('booking');
    expect(segments[1]).toBe(TOKEN);
  });

  it('does not claim a neighbouring path that merely starts with the prefix', () => {
    expect(frameAncestorsFor('/bookingz/alex/intro')).toBe('*');
    expect(isProductPath('/bookingz/alex/intro')).toBe(false);
  });
});
