import { describe, it, expect } from 'vitest';
import {
  CANVAS_HEX,
  DEFAULT_ACCENT,
  DEFAULT_BOOKING_THEME,
  MIN_ACCENT_CONTRAST,
  accentCanvasContrast,
  accentEdge,
  accentInk,
  accentLabelContrast,
  accentVars,
  brandVars,
  clampAccent,
  contrastRatioExact,
  onAccent,
  type BrandCanvas,
} from './branding';

/**
 * The branding engine (ADR 0004, as amended 2026-09-11). Every assertion here is
 * a LAW stated against a ground, not a snapshot of a hex value.
 *
 * THE LAW INVERTED, AND THE FILE KEPT. Until the amendment this engine adjusted
 * a host's accent until it cleared 3:1 against the canvas, and this file swept
 * the sRGB cube proving the floor held. The product owner reversed that: a host
 * owns their brand, and an accent renders exactly as picked even when it is
 * illegible. The sweep did not go away — it changed sides. It now proves the
 * colour comes back UNCHANGED, which is the assertion that fails the moment
 * someone quietly reinstates the clamp because a page looked wrong to them.
 *
 * ONE FLOOR SURVIVED, and the sweep proves that too. `onAccent` is not the
 * host's colour; it is the black-or-white label the engine invents to sit ON
 * their colour. A host who picks dark green never chose black text on dark
 * green, so that pick keeps its rule while everything above it lost one.
 *
 * Two things this file learned the hard way and keeps.
 *
 * It measures with `contrastRatioExact`, never `contrastRatio`. The rounded one
 * exists to drive a UI readout, and `tokens.spec.ts` accepts its 1% slack on
 * purpose — the sheet's values are hand-tuned and sit far from every threshold.
 * A law about a generated colour cannot afford that: a true 2.98:1 rounds to a
 * passing 3.0.
 *
 * And it sweeps rather than sampling. The rounding defect the previous laws were
 * written to pin down affected roughly 1 accent in 400 — invisible to any
 * hand-picked fixture list, and it produced a real preview-vs-production split.
 * A law about every colour a host can pick has to be tested against a lot of
 * them.
 */

const CANVASES: readonly BrandCanvas[] = ['dark', 'light'];

/** The second ground each canvas paints on — a card, not the page behind it. */
const CARD_HEX: Record<BrandCanvas, string> = { dark: '#101418', light: '#ffffff' };

/** The real page grounds, which `CANVAS_HEX` is deliberately stricter than. */
const PAGE_HEX: Record<BrandCanvas, string> = { dark: '#0a0c0e', light: '#f4f6f8' };

/** Every ground a colour actually lands on, per canvas. */
const GROUNDS: Record<BrandCanvas, readonly string[]> = {
  dark: [CANVAS_HEX.dark, PAGE_HEX.dark, CARD_HEX.dark],
  light: [CANVAS_HEX.light, PAGE_HEX.light, CARD_HEX.light],
};

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

/** Named picks worth calling out by hand, including four that sat in the old
 *  clamp's rounding band and broke the floor, idempotence, and edge-equals-fill. */
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

describe('the default canvas', () => {
  it('is the console', () => {
    // Half of a fact that is declared twice. The other half is
    // `bookingPageStyleSchema.theme`'s zod `.default()` in @slate/types, and the
    // two are asserted EQUAL by apps/web/lib/booking-canvas.spec.ts — this
    // package cannot see the contract, so the parity test lives where both are
    // reachable. A split between them parses one canvas and paints the other,
    // with no error anywhere.
    expect(DEFAULT_BOOKING_THEME).toBe('dark');
  });
});

describe('clampAccent — the host colour, unaltered', () => {
  it('returns every colour in the sweep byte for byte, on both canvases', () => {
    // The inverted sweep. This is the assertion that fails if anyone reinstates
    // the clamp, on either ground, for any colour.
    for (const canvas of CANVASES) {
      const moved = ALL.filter((c) => clampAccent(c, canvas) !== c);
      expect(moved.slice(0, 5), `${moved.length} colours were altered on ${canvas}`).toEqual([]);
    }
  });

  it('travels toward neither pole, in either direction', () => {
    // The two cases the old bidirectional clamp existed for. Near-black used to
    // be lightened on the console and a pale yellow darkened on paper; neither
    // moves now.
    for (const canvas of CANVASES) {
      expect(clampAccent('#000000', canvas)).toBe('#000000');
      expect(clampAccent('#ffee88', canvas)).toBe('#ffee88');
      expect(lightness(clampAccent('#000000', canvas))).toBe(lightness('#000000'));
    }
  });

  it('gives the same hex back whichever canvas the page moved to', () => {
    // A host who flips their booking page between grounds gets the colour they
    // picked on both. Under the clamp the SAME accent came out as two different
    // hexes, which is the visible half of what the amendment reverses:
    // `#cbe84f` rendered `#7a8b21` olive on paper.
    for (const accent of ACCENTS) {
      expect(clampAccent(accent, 'dark'), accent).toBe(clampAccent(accent, 'light'));
    }
    expect(clampAccent('#cbe84f', 'light')).toBe('#cbe84f');
    expect(clampAccent('#cbe84f', 'dark')).toBe('#cbe84f');
    expect(clampAccent('#001f3f', 'dark')).toBe('#001f3f');
  });

  it('is idempotent for every colour in the sweep', () => {
    // Trivial for an identity, and kept anyway: the studio saves an accent that
    // the public page reads back, so a derivation that moved a second time meant
    // the host previewed one colour and shipped another, drifting further on
    // every save. It is the property that has to hold, not the mechanism.
    for (const canvas of CANVASES) {
      const drifted = ALL.filter((c) => {
        const once = clampAccent(c, canvas);
        return clampAccent(once, canvas) !== once;
      });
      expect(drifted.slice(0, 5), `${drifted.length} colours drift on ${canvas}`).toEqual([]);
    }
  });

  it('still falls back to the DS accent when the hex will not parse', () => {
    // The half of this function that did NOT change, and the reason it keeps a
    // job at all. apps/web/lib/embed.ts lets a pasted snippet override the
    // accent from the URL; a typo there has to degrade, not break the page.
    for (const canvas of CANVASES) {
      for (const junk of ['nope', '', '#12', 'nonsense', '#ggghhh']) {
        expect(clampAccent(junk, canvas), junk).toBe(DEFAULT_ACCENT);
      }
    }
    // Returned RAW now. There is no clamp left to put it through, and the DS
    // lime is 1.2:1 on paper — which is exactly the kind of thing a host is now
    // warned about rather than protected from.
    expect(contrastRatioExact(clampAccent('nope', 'light'), CANVAS_HEX.light)).toBeLessThan(NON_TEXT);
  });

  it('survives a canvas value that is not one of the two', () => {
    // B2 reads this off jsonb, where a row can carry 'Dark' or null. A public
    // booking page must not 500 over it.
    for (const bogus of ['Dark', '', null, undefined, 'sepia']) {
      expect(clampAccent('#c2261c', bogus as unknown as BrandCanvas)).toBe('#c2261c');
    }
  });

  it('lets an illegible accent through — the accepted cost, asserted', () => {
    // Deliberate, decided by the product owner, and recorded in ADR 0004 so it
    // is not rediscovered as a bug. Pinned as a test for the same reason: a
    // future reader who "fixes" this page will have to delete an assertion that
    // says the behaviour is intended.
    const illegible: Record<BrandCanvas, string> = { dark: '#2a2a2a', light: '#cbe84f' };
    for (const canvas of CANVASES) {
      const pick = illegible[canvas];
      expect(clampAccent(pick, canvas)).toBe(pick);
      expect(contrastRatioExact(pick, CANVAS_HEX[canvas])).toBeLessThan(NON_TEXT);
    }
  });

  it('keeps the onAccent floor for every colour in the sweep', () => {
    // The one floor that survived. `onAccent` is the label ON the fill, not the
    // fill, so it is the engine's own value and not the host's to get wrong —
    // without it a host who picks dark green gets black text on dark green.
    // Measured against the fill itself, which is what the label sits on, so the
    // canvas does not enter into it: this holds wherever the page is painted.
    const failed = ALL.filter((c) => contrastRatioExact(c, onAccent(c)) < NON_TEXT);
    expect(failed.slice(0, 5), `${failed.length} colours lose their own label`).toEqual([]);
    // And it holds through the fill the page actually renders, on both canvases —
    // measured against that fill, not against a fixed ground, or the assertion
    // would pass no matter what `onAccent` returned.
    for (const canvas of CANVASES) {
      const lost = ALL.filter((c) => {
        const fill = clampAccent(c, canvas);
        return contrastRatioExact(fill, onAccent(fill)) < NON_TEXT;
      });
      expect(lost.slice(0, 5), `${lost.length} rendered fills lose their label on ${canvas}`).toEqual([]);
    }
  });
});

describe('accentInk / accentEdge — the accent in its other two jobs', () => {
  it('are the host colour, not a derived one, for every colour on both canvases', () => {
    // Ink used to carry AA (4.5:1) and edge the 3:1 non-text floor, so ink was a
    // different hex from the fill on both themes. The amendment applies to the
    // accent in every one of its jobs: a host's links are the colour they chose,
    // exactly as their buttons are.
    for (const canvas of CANVASES) {
      const inkApart = ALL.filter((c) => accentInk(c, canvas) !== c);
      expect(inkApart.slice(0, 5), `${inkApart.length} inks differ on ${canvas}`).toEqual([]);
      // Against the INPUT, not against `clampAccent`: if the clamp came back the
      // two would move together and an edge-equals-fill assertion would still pass.
      const edgeApart = ALL.filter((c) => accentEdge(c, canvas) !== c);
      expect(edgeApart.slice(0, 5), `${edgeApart.length} edges differ on ${canvas}`).toEqual([]);
    }
  });

  it('no longer clear the AA floor, and that is the decision rather than a gap', () => {
    // Stated as an assertion so reinstating the ink clamp fails here too. The DS
    // lime as LETTERS on paper is the textbook case: 1.2:1, shipped.
    expect(contrastRatioExact(accentInk(DEFAULT_ACCENT, 'light'), CANVAS_HEX.light)).toBeLessThan(4.5);
    expect(accentInk(DEFAULT_ACCENT, 'light')).toBe(DEFAULT_ACCENT);
  });

  it('derives both from the HOST accent, never from the product lime', () => {
    // The bug ADR 0004 names, and the half of it the amendment does NOT touch: a
    // branded surface that does not emit these two repossesses the accent back
    // to ours. That was never about contrast. A red-branded host must get no lime.
    const red = '#c2261c';
    for (const canvas of CANVASES) {
      expect(accentInk(red, canvas)).toBe(red);
      expect(accentEdge(red, canvas)).toBe(red);
      expect(accentInk(red, canvas)).not.toBe(DEFAULT_ACCENT);
      expect(accentEdge(red, canvas)).not.toBe(DEFAULT_ACCENT);
    }
  });
});

describe('the two contrast readouts the studio prints', () => {
  it('accentCanvasContrast measures the accent against the ground, and can fail', () => {
    // The number the clamp used to act on. Now nothing acts on it but the host.
    expect(accentCanvasContrast(DEFAULT_ACCENT, 'dark')).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    expect(accentCanvasContrast(DEFAULT_ACCENT, 'light')).toBeLessThan(MIN_ACCENT_CONTRAST);
    // Same tolerance as everything else that reads a stored jsonb value.
    expect(accentCanvasContrast('#c2261c', 'sepia' as unknown as BrandCanvas)).toBe(
      accentCanvasContrast('#c2261c', 'dark'),
    );
    // An unparseable hex is measured as the fallback actually rendered, not as 0.
    expect(accentCanvasContrast('nope', 'dark')).toBe(accentCanvasContrast(DEFAULT_ACCENT, 'dark'));
  });

  it('truncates rather than rounding, so the 2.9x band cannot read as passing', () => {
    // The defect this function exists to avoid. Rounding to NEAREST reports a
    // true 2.9885:1 as `3`, and the studio decides on this number — roughly 4,500
    // colours per canvas would sit under the floor and never warn. Truncating can
    // only understate, so the number shown and the number acted on are one value.
    for (const [hex, canvas] of [
      ['#0066dd', 'dark'],
      ['#007777', 'dark'],
      ['#1699cc', 'light'],
    ] as [string, BrandCanvas][]) {
      const exact = contrastRatioExact(hex, CANVAS_HEX[canvas]);
      expect(exact, `${hex} on ${canvas} is meant to sit just under the floor`).toBeLessThan(NON_TEXT);
      expect(exact).toBeGreaterThan(2.9);
      expect(accentCanvasContrast(hex, canvas), `${hex} on ${canvas}`).toBeLessThan(MIN_ACCENT_CONTRAST);
    }
    // No colour may report a ratio it does not have, anywhere in the cube.
    for (const canvas of CANVASES) {
      const overstated = ALL.filter(
        (c) => accentCanvasContrast(c, canvas) > contrastRatioExact(c, CANVAS_HEX[canvas]),
      );
      expect(overstated.slice(0, 5), `${overstated.length} overstate on ${canvas}`).toEqual([]);
    }
  });

  it('accentLabelContrast can never trip the warning, which is why there are two', () => {
    // `onAccent` keeps its floor, so the label readout bottoms out around 4.1:1
    // over the whole cube. A single readout would therefore have printed a
    // comfortable number for an accent that is invisible on the page — the two
    // measure different grounds and the studio names both.
    for (const canvas of CANVASES) {
      const low = Math.min(...ALL.map((c) => accentLabelContrast(c, canvas)));
      expect(low, `worst label readout on ${canvas}`).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });
});

describe('accentVars — hover follows the canvas', () => {
  it('hovers lighter on dark and darker on light', () => {
    // The one derivation that still MOVES a colour, and not for legibility: a
    // hover mixing toward white on paper would fade toward the page it sits on.
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
    // Fill, letters and rim are one colour now. They remain five separate keys
    // because globals.css reads five separate tokens.
    for (const canvas of CANVASES) {
      const mismatched = ALL.filter((c) => {
        const v = brandVars(c, canvas);
        return (
          v['--primary'] !== v['--accent'] ||
          v['--primary'] !== v['--primary-ink'] ||
          v['--primary'] !== v['--primary-edge'] ||
          v['--primary'] !== v['--ring']
        );
      });
      expect(mismatched.slice(0, 5), `${mismatched.length} colours disagree on ${canvas}`).toEqual([]);
    }
  });

  it('never emits a label that loses its fill — the one surviving floor', () => {
    // `onAccent` is the only contrast rule left, so it is asserted where it is
    // actually consumed. Without this a future refactor could compute the label
    // from the RAW input while the fill came from somewhere else, and every other
    // law in this file would still pass.
    for (const canvas of CANVASES) {
      const lost = ALL.filter((c) => {
        const v = brandVars(c, canvas);
        return (
          contrastRatioExact(v['--primary']!, v['--primary-foreground']!) < NON_TEXT ||
          contrastRatioExact(v['--accent']!, v['--accent-contrast']!) < NON_TEXT
        );
      });
      expect(lost.slice(0, 5), `${lost.length} colours lose their label on ${canvas}`).toEqual([]);
    }
  });

  it('emits the host accent as primary/ink/edge/ring on BOTH canvases', () => {
    for (const canvas of CANVASES) {
      for (const accent of ACCENTS) {
        const vars = brandVars(accent, canvas);
        expect(vars['--primary'], `${accent} on ${canvas}`).toBe(accent);
        expect(vars['--primary-ink'], `${accent} on ${canvas}`).toBe(accent);
        expect(vars['--primary-edge'], `${accent} on ${canvas}`).toBe(accent);
        expect(vars['--ring'], `${accent} on ${canvas}`).toBe(accent);
      }
    }
  });

  it('carries the widget-independent accent vars through unchanged, on both', () => {
    for (const canvas of CANVASES) {
      const vars = brandVars('#c2261c', canvas);
      expect(vars['--accent']).toBe('#c2261c');
      // The wash composites against the SURFACE's `--background`, never a baked
      // hex — which is the whole reason `BrandedShell` and the studio preview
      // have to stamp `data-theme` as well as the accent. A preview that emits
      // the accent but inherits the admin's ground resolves this token against
      // the wrong canvas while the accent itself matches (B2, #109).
      expect(vars['--accent-wash']).toContain('var(--background)');
    }
  });

  /**
   * The studio's own swatch row, on both grounds.
   *
   * These six are the colours a host reaches without opening a colour picker, so
   * they are the accents most booking pages actually carry. Kept in sync with
   * `ACCENT_PRESETS` in the studio by hand; a preset added there and not here
   * simply is not covered, which is why the list is short and named.
   */
  describe('the studio presets', () => {
    const STUDIO_PRESETS = ['#cbe84f', '#9059fc', '#4f9cff', '#4fd18b', '#ff9f4f', '#ff6fae'];

    it('render as picked on both canvases', () => {
      for (const canvas of CANVASES) {
        for (const preset of STUDIO_PRESETS) {
          expect(clampAccent(preset, canvas), `${preset} on ${canvas}`).toBe(preset);
        }
      }
    });

    it('clear the fill floor on the console, which is the default canvas', () => {
      // The presets were chosen against the product's own dark ground, so the
      // default page is legible with any of them — on the reference ground, the
      // real page, and a card.
      for (const ground of GROUNDS.dark) {
        const fill = worst(STUDIO_PRESETS, (c) => clampAccent(c, 'dark'), ground);
        expect(fill.low, `fill ${fill.at} on dark/${ground}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    });

    it('do NOT all clear it on paper, and the studio warns instead of correcting', () => {
      // The accepted cost at its most visible: a host who moves their page to
      // light and keeps the DS lime ships a 1.2:1 accent. The engine used to
      // darken it to olive. It now renders as picked, and `accentCanvasContrast`
      // is below the floor — which is exactly when the studio shows its warning.
      const below = STUDIO_PRESETS.filter((c) => accentCanvasContrast(c, 'light') < MIN_ACCENT_CONTRAST);
      expect(below).toContain(DEFAULT_ACCENT);
      // And it is not an artefact of the strict reference ground: the lime fails
      // on the real light page and on a white card too.
      for (const ground of GROUNDS.light) {
        expect(contrastRatioExact(DEFAULT_ACCENT, ground), ground).toBeLessThan(NON_TEXT);
      }
    });

    it('keeps a preset label off the floor on either canvas', () => {
      // `onAccent` picks the better of black and white, and a saturated mid-tone
      // clears 4.5:1 against neither — the studio's own purple measures 4.15:1
      // on both canvases and did so before the amendment existed. The non-text
      // floor is the line that does hold, and this pins that a host's button
      // never loses its own label however they set the rest of the page.
      for (const canvas of CANVASES) {
        for (const preset of STUDIO_PRESETS) {
          const fill = clampAccent(preset, canvas);
          expect(
            contrastRatioExact(fill, onAccent(fill)),
            `${preset} label on ${canvas}`,
          ).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    });
  });
});
