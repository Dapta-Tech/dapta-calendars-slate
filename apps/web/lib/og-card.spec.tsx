import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OG_GROUND, clip, mixHex } from './og-card';

/**
 * The card restates the booking ground's colours because Satori cannot read a
 * stylesheet. This holds the copy to the source: the `.bp-ground` blocks in
 * `@slate/shared/tokens.css`, frozen for every live booking page.
 */
const tokens = readFileSync(new URL('../../../packages/shared/src/tokens.css', import.meta.url), 'utf8');

function groundBlock(canvas: 'light' | 'dark'): string {
  const start = tokens.indexOf(`.bp-ground[data-theme='${canvas}'] {`);
  expect(start).toBeGreaterThan(-1);
  return tokens.slice(start, tokens.indexOf('}', start));
}
function token(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m![1]!.trim();
}

describe('the link preview card', () => {
  for (const canvas of ['light', 'dark'] as const) {
    it(`paints the ${canvas} booking ground exactly as tokens.css does`, () => {
      const block = groundBlock(canvas);
      expect(OG_GROUND[canvas]).toEqual({
        background: token(block, 'background'),
        foreground: token(block, 'foreground'),
        muted: token(block, 'muted-foreground'),
        border: token(block, 'border'),
      });
    });
  }

  it('clips host text on a word, never mid-word', () => {
    expect(clip('A short title', 64)).toBe('A short title');
    expect(clip('Quarterly planning session for the design team and friends', 40)).toBe(
      'Quarterly planning session for the…',
    );
    expect(clip('  spaced   out\ntext ', 64)).toBe('spaced out text');
  });

  it('mixes the monogram tint the way color-mix does', () => {
    expect(mixHex('#2f6fed', '#f4f6f8', 0.16)).toBe('#d4e0f6');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
