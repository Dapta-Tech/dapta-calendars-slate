import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookingCard, OG_GROUND, OG_PANEL, OG_SAFE_SQUARE, OG_SIZE, clip, mixHex } from './og-card';

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
        card: token(block, 'card'),
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

  /**
   * Slack paints a link's image as a square cut from its middle, beside the
   * text (seen 2026-11-24: a left-aligned title showed as "sta oficina"). The panel that
   * carries the host, the title, the length and the button must sit inside
   * that square with room to spare, on both axes.
   */
  it('keeps everything that matters inside the square a chat crops to', () => {
    expect(OG_SAFE_SQUARE).toEqual({ left: (OG_SIZE.width - OG_SIZE.height) / 2, size: OG_SIZE.height });
    expect(OG_PANEL.left).toBeGreaterThanOrEqual(OG_SAFE_SQUARE.left + 16);
    expect(OG_PANEL.left + OG_PANEL.width).toBeLessThanOrEqual(OG_SAFE_SQUARE.left + OG_SAFE_SQUARE.size - 16);
    expect(OG_PANEL.top).toBeGreaterThanOrEqual(16);
    expect(OG_PANEL.top + OG_PANEL.height).toBeLessThanOrEqual(OG_SIZE.height - 16);
  });

  it('draws the host, the title, the length and the button on the panel, the product outside it', () => {
    const html = renderToStaticMarkup(
      BookingCard({
        kind: 'event',
        canvas: 'dark',
        accent: '#c8e64a',
        hostName: 'Felipe',
        photo: null,
        title: 'Entrevista oficina',
        duration: '60 min',
        cta: 'Reserva una hora',
        productName: 'dCal',
      }),
    );
    const panelAt = html.indexOf(`left:${OG_PANEL.left}px`);
    expect(panelAt).toBeGreaterThan(-1);
    const panel = html.slice(panelAt);
    for (const text of ['Felipe', 'Entrevista oficina', '60 min', 'Reserva una hora']) expect(panel).toContain(text);
    // The mark is drawn before the panel, in its own corner.
    expect(html.slice(0, panelAt)).toContain('dCal');
    expect(panel).not.toContain('dCal');
  });

  it('mixes the monogram tint the way color-mix does', () => {
    expect(mixHex('#2f6fed', '#f4f6f8', 0.16)).toBe('#d4e0f6');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
