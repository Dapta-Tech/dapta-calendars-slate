import { describe, it, expect } from 'vitest';
import {
  CANVAS_HEX,
  DEFAULT_ACCENT,
  accentEdge,
  accentInk,
  accentVars,
  accentWasAdjusted,
  brandVars,
  clampAccent,
  contrastRatioExact,
  type BrandCanvas,
} from './branding';

/**
 * The theme-aware branding engine (ADR 0004). Every assertion here is a LAW
 * stated against a ground, not a snapshot of a hex value: the engine's job is
 * "this colour is legible on that canvas", and a test that pinned the output
 * would break on any retune of the step size while telling us nothing about
 * whether a host's page is readable.
 *
 * Two things this file learned the hard way.
 *
 * It measures with `contrastRatioExact`, never `contrastRatio`. The rounded one
 * exists to drive a UI readout, and `tokens.spec.ts` accepts its 1% slack on
 * purpose — the sheet's values are hand-tuned and sit far from every threshold.
 * The engine's own output does not: the clamp stops on the first value that
 * crosses its floor, so results park ON the boundary, exactly where a true
 * 2.98:1 rounds to a passing 3.0.
 *
 * And it sweeps rather than sampling. The rounding defect these laws were
 * written to pin down affected roughly 1 accent in 400 — invisible to any
 * hand-picked fixture list, and it produced a real preview-vs-production split.
 * A law about every colour a host can pick has to be tested against a lot of
 * them.
 */

const CANVASES: readonly BrandCanvas[] = ['dark', 'light'];

/** The second ground each canvas paints on — a card, not the page behind it.
 *  Both must hold: `--primary-ink` is used as letters on cards too. */
const CARD_HEX: Record<BrandCanvas, string> = { dark: '#101418', light: '#ffffff' };

/** The real page grounds, which `CANVAS_HEX` is deliberately stricter than. */
const PAGE_HEX: Record<BrandCanvas, string> = { dark: '#0a0c0e', light: '#f4f6f8' };

const AA = 4.5;
const NON_TEXT = 3;

/** Every 9th value per channel: 24,389 colours, ~0.4s per law. Coarse enough to
 *  stay a unit test, dense enough that the 1-in-400 rounding band cannot hide. */
function sweep(): string[] {
  const out: string[] = [];
  for (let r = 0; r < 256; r += 9)
    for (let g = 0; g < 256; g += 9)
      for (let b = 0; b < 256; b += 9)
        out.push('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''));
  return out;
}
const ALL = sweep();

/** Named picks worth calling out by hand, including four that sat in the
 *  rounding band and broke the floor, idempotence, and edge-equals-clamp. */
const ACCENTS = [
  '#000000',
  '#001f3f',
  '#c2261c',
  DEFAULT_ACCENT,
  '#ffee88',
  '#ffffff',
  '#002868',
  '#00005e',
  '#006655',
  '#00b0dc',
  '#f6f612',
  '#222255',
];

/** Relative lightness proxy: contrast against white falls as a colour lightens. */
const lightness = (hex: string): number => 1 / contrastRatioExact(hex, '#ffffff');

/** Report the worst offender rather than just the first, so a failure message
 *  says how bad it is instead of only that it happened. */
function worst(colors: string[], produce: (c: string) => string, ground: string) {
  let low = Infinity;
  let at = '';
  for (const c of colors) {
    const r = contrastRatioExact(produce(c), ground);
    if (r < low) {
      low = r;
      at = c;
    }
  }
  return { low, at };
}

describe('clampAccent — bidirectional, canvas-aware', () => {
  it('clears the 3:1 fill floor on its canvas, for every colour in the sweep', () => {
    for (const canvas of CANVASES) {
      const { low, at } = worst(ALL, (c) => clampAccent(c, canvas), CANVAS_HEX[canvas]);
      expect(low, `worst on ${canvas} was ${at} -> ${clampAccent(at, canvas)}`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('lightens on a dark ground and darkens on a light one', () => {
    // Near-black is illegible on the console; it must travel toward white.
    expect(lightness(clampAccent('#000000', 'dark'))).toBeGreaterThan(lightness('#000000'));
    // A pale yellow is illegible on paper; it must travel toward black.
    expect(lightness(clampAccent('#ffee88', 'light'))).toBeLessThan(lightness('#ffee88'));
  });

  it('leaves a navy alone on paper instead of washing it out', () => {
    // The exact regression ADR 0004 names: the one-directional clamp lightened a
    // dark brand colour to clear the DARK canvas, and the result was unreadable
    // on a light booking page. On `light` the navy already clears 3:1, so the
    // engine must not touch it.
    expect(clampAccent('#001f3f', 'light')).toBe('#001f3f');
    expect(accentWasAdjusted('#001f3f', 'light')).toBe(false);
    // ...and on the dark canvas it still gets lightened, as it always did.
    expect(accentWasAdjusted('#001f3f', 'dark')).toBe(true);
  });

  it('is idempotent for every colour in the sweep', () => {
    // Not a nicety. The studio and the public page both clamp, so a clamp that
    // moved a second time meant the host previewed one colour and shipped
    // another — and re-saving drifted it further every time.
    for (const canvas of CANVASES) {
      const drifted = ALL.filter((c) => {
        const once = clampAccent(c, canvas);
        return clampAccent(once, canvas) !== once;
      });
      expect(drifted.slice(0, 5), `${drifted.length} colours drift on ${canvas}`).toEqual([]);
    }
  });

  it('falls back to the DS accent, clamped for the canvas, when the hex will not parse', () => {
    expect(clampAccent('nope', 'dark')).toBe(DEFAULT_ACCENT);
    // On paper the DS lime is 1.2:1, so the fallback has to be clamped too —
    // returning it raw would hand a light page an invisible accent.
    expect(contrastRatioExact(clampAccent('nope', 'light'), CANVAS_HEX.light)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it('survives a canvas value that is not one of the two', () => {
    // B2 reads this off jsonb, where a row can carry 'Dark' or null. A public
    // booking page must not 500 over it; it renders on the ground it always had.
    for (const bogus of ['Dark', '', null, undefined, 'sepia']) {
      expect(clampAccent('#c2261c', bogus as unknown as BrandCanvas)).toBe(clampAccent('#c2261c', 'dark'));
    }
  });

  it('preserves the pre-B1 dark-canvas behaviour for accents that were already legible', () => {
    expect(clampAccent(DEFAULT_ACCENT, 'dark')).toBe(DEFAULT_ACCENT);
    expect(accentWasAdjusted(DEFAULT_ACCENT, 'dark')).toBe(false);
    expect(accentWasAdjusted('#000000', 'dark')).toBe(true);
  });
});

describe('accentInk / accentEdge — the accent in its other two jobs', () => {
  it('ink clears AA as letters, on the reference ground, the real page, and a card', () => {
    for (const canvas of CANVASES) {
      for (const ground of [CANVAS_HEX[canvas], PAGE_HEX[canvas], CARD_HEX[canvas]]) {
        const { low, at } = worst(ALL, (c) => accentInk(c, canvas), ground);
        expect(low, `worst ink on ${canvas}/${ground} was ${at} -> ${accentInk(at, canvas)}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('edge clears the 3:1 non-text floor, on all three grounds', () => {
    for (const canvas of CANVASES) {
      for (const ground of [CANVAS_HEX[canvas], PAGE_HEX[canvas], CARD_HEX[canvas]]) {
        const { low, at } = worst(ALL, (c) => accentEdge(c, canvas), ground);
        expect(low, `worst edge on ${canvas}/${ground} was ${at}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it('edge equals the clamped fill, because the two floors are equal', () => {
    // Documented as coinciding "by construction". It has to be provable, not
    // observed — while the clamp measured a value it did not ship, the two came
    // apart for ~1 accent in 400 and nobody noticed.
    for (const canvas of CANVASES) {
      const apart = ALL.filter((c) => accentEdge(c, canvas) !== clampAccent(c, canvas));
      expect(apart.slice(0, 5), `${apart.length} colours differ on ${canvas}`).toEqual([]);
    }
  });

  it('derives both from the HOST accent, never from the product lime', () => {
    // The bug ADR 0004 names: a branded surface that does not emit these two
    // repossesses the accent back to ours. A red-branded host must get no lime.
    const red = '#c2261c';
    for (const canvas of CANVASES) {
      expect(accentInk(red, canvas)).not.toBe(DEFAULT_ACCENT);
      expect(accentEdge(red, canvas)).not.toBe(DEFAULT_ACCENT);
      expect(accentInk(red, canvas)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('accentVars — hover follows the canvas', () => {
  it('hovers lighter on dark and darker on light', () => {
    const accent = '#c2261c';
    const onDark = accentVars(accent, 'dark');
    const onLight = accentVars(accent, 'light');
    expect(lightness(onDark['--accent-hover']!)).toBeGreaterThan(lightness(onDark['--accent']!));
    expect(lightness(onLight['--accent-hover']!)).toBeLessThan(lightness(onLight['--accent']!));
  });
});

describe('brandVars — the single block a branded surface emits', () => {
  const REQUIRED = ['--primary', '--primary-foreground', '--primary-ink', '--primary-edge', '--ring'];

  it('emits every product accent token, so none can fall through to ours', () => {
    for (const canvas of CANVASES) {
      const vars = brandVars('#c2261c', canvas);
      for (const key of REQUIRED) {
        expect(vars[key], `${key} on ${canvas}`).toBeTruthy();
        expect(vars[key]).not.toBe(DEFAULT_ACCENT);
      }
    }
  });

  it('never disagrees with itself about what the accent is', () => {
    // `--primary` came from one clamp and `--primary-edge` from a second, so the
    // block could paint a fill and rim it in a different colour.
    for (const canvas of CANVASES) {
      const mismatched = ALL.filter((c) => {
        const v = brandVars(c, canvas);
        return v['--primary'] !== v['--accent'] || v['--primary'] !== v['--primary-edge'] || v['--primary'] !== v['--ring'];
      });
      expect(mismatched.slice(0, 5), `${mismatched.length} colours disagree on ${canvas}`).toEqual([]);
    }
  });

  it('emits the clamped accent as primary/edge/ring on the dark canvas', () => {
    // Slice F emitted the plain clamped accent for these three. B1 derives them,
    // and on the dark canvas the derivation must land on the same value, so no
    // already-saved host page moves.
    for (const accent of ACCENTS) {
      const vars = brandVars(accent, 'dark');
      const clamped = clampAccent(accent, 'dark');
      expect(vars['--primary']).toBe(clamped);
      expect(vars['--primary-edge']).toBe(clamped);
      expect(vars['--ring']).toBe(clamped);
    }
  });

  it('carries the widget-independent accent vars through unchanged', () => {
    const vars = brandVars('#c2261c', 'light');
    expect(vars['--accent']).toBe(clampAccent('#c2261c', 'light'));
    expect(vars['--accent-wash']).toContain('var(--background)');
  });
});
