/**
 * The design language's contrast law, asserted over the token sheet that ships.
 *
 * This spec parses `src/tokens.css` itself rather than a TypeScript mirror of the
 * palette, because a mirror is a second source of truth for colour and the whole
 * point of the sheet is that there is one. It resolves the `--acc-h/--acc-s/--acc-l`
 * channels into their `hsl()` compositions and composites the `rgba()` hairline and
 * input edge over the grounds they actually sit on, so what is measured is the
 * colour a viewer sees and not the string a developer typed.
 *
 * It exists because the light theme is authored, tested and — until slice T — not
 * reachable in the running app. Nobody can catch a 1.3:1 link by looking at a
 * screen that never renders it, and the failure mode of "simplify the light block
 * back into a tonal mirror of the dark one" is invisible until it ships. Here it is
 * pure arithmetic, so it is caught for free.
 *
 * The ratios use the engine's own `contrastRatio`, so the sheet and `clampAccent`
 * can never disagree about what 4.5:1 means.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { contrastRatio } from './branding';

/* `contrastRatio` rounds to one decimal (it exists to drive a UI readout), so a
   true 4.45:1 reports as 4.5 and clears this bar. That 1% of slack is accepted
   rather than worked around: using the engine's own function is the point of this
   spec — a palette must not be able to pass here and fail the clamp — and every
   value the sheet actually ships sits well clear of the boundary (the tightest is
   4.7:1). If a future token lands inside 0.05 of a threshold, tighten the token
   rather than the assertion. */
const AA = 4.5; // WCAG 1.4.3 — body text.
const NON_TEXT = 3; // WCAG 1.4.11 — anything that identifies a control or its state.

const TOKENS_CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/* The type scale and radius ladder are NOT asserted here. They are mapped in the
   web app's `@theme inline` block, and reading that file from a package spec would
   make `@slate/shared` depend on `apps/web` — the one direction ARCHITECTURE.md
   forbids outright ("nothing depends on an app"), test-only file read or not. The
   app has no test runner and this slice does not stand one up, so the scale and the
   ladder are verified by hand instead (see the QA checklist on the pull request).
   The colour law stays here, because it is the part that bites silently: a scale
   whose steps cross is visible the moment anyone looks at the screen, and a 1.3:1
   link on a theme nobody has rendered yet is not. */

// --- CSS reading -----------------------------------------------------------

/** Comments carry hex values and colons, so they go before anything is parsed. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the first rule whose selector text starts at `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no rule for selector: ${selector}`);
  const open = css.indexOf('{', start + selector.length);
  if (open < 0) throw new Error(`no block for selector: ${selector}`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated block for selector: ${selector}`);
}

/** The `--name: value` declarations in a rule body, in source order. */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * The PLAIN (non-custom) property declarations in a rule body — the mirror of
 * `declarations()` above, which reads `--*` only.
 *
 * A theme block is not only its tokens. `color-scheme` is a plain property and
 * decides what the BROWSER paints for itself, so a parity check that reads
 * custom properties alone is blind to half of what a theme declares. The two
 * readers together are the whole rule.
 */
function plainDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const match = /^\s*([a-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(decl);
    if (match && !match[1].startsWith('--')) out[match[1]] = match[2].trim();
  }
  return out;
}

const sheet = stripComments(TOKENS_CSS);
const BASE_BODY = ruleBody(sheet, ':root,');
const LIGHT_BODY = ruleBody(sheet, ":root[data-theme='light']");
const PREFERS_BODY = ruleBody(
  ruleBody(sheet, '@media (prefers-color-scheme: light)'),
  ":root:not([data-theme='dark'])",
);
const BASE = declarations(BASE_BODY);
const LIGHT = declarations(LIGHT_BODY);
const PREFERS = declarations(PREFERS_BODY);

/** A theme is the base declarations with that theme's overrides applied. */
const THEMES: Record<string, Record<string, string>> = {
  dark: BASE,
  light: { ...BASE, ...LIGHT },
  'prefers-color-scheme: light': { ...BASE, ...PREFERS },
};

// --- Colour resolution -----------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

/** A number, a percentage, or a `var(--name)` that resolves to either. */
function channel(raw: string, vars: Record<string, string>): number {
  const value = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw.trim())?.[1];
  const text = value ? vars[value] : raw;
  if (text === undefined) throw new Error(`unresolved channel: ${raw}`);
  return parseFloat(text);
}

/** Resolve a declared token value to straight RGBA. Alpha is kept, not flattened. */
function resolve(token: string, vars: Record<string, string>): Rgba {
  const value = vars[token];
  if (value === undefined) throw new Error(`token not declared: ${token}`);

  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const hsl = /^hsl\((.+)\)$/i.exec(value);
  if (hsl) {
    const [space, alpha] = hsl[1].split('/');
    const parts = space.trim().split(/\s+/);
    const rgb = hslToRgb(channel(parts[0], vars), channel(parts[1], vars), channel(parts[2], vars));
    return { ...rgb, a: alpha === undefined ? 1 : parseFloat(alpha) };
  }

  const rgba = /^rgba?\((.+)\)$/i.exec(value);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => p.trim());
    return {
      r: parseFloat(parts[0]),
      g: parseFloat(parts[1]),
      b: parseFloat(parts[2]),
      a: parts[3] === undefined ? 1 : channel(parts[3], vars),
    };
  }

  throw new Error(`unrecognised colour syntax for ${token}: ${value}`);
}

function toHex({ r, g, b }: Rgba): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** A token as it actually paints on a ground — translucency composited away. */
function over(token: string, ground: string, vars: Record<string, string>): string {
  const fg = resolve(token, vars);
  const bg = resolve(ground, vars);
  if (fg.a >= 1) return toHex(fg);
  return toHex({
    r: bg.r + (fg.r - bg.r) * fg.a,
    g: bg.g + (fg.g - bg.g) * fg.a,
    b: bg.b + (fg.b - bg.b) * fg.a,
    a: 1,
  });
}

/** The measured ratio of a token against a ground, both composited first. */
function ratio(token: string, ground: string, vars: Record<string, string>): number {
  return contrastRatio(over(token, ground, vars), over(ground, ground, vars));
}

// --- The law ---------------------------------------------------------------

describe.each(Object.entries(THEMES))('token sheet contrast law — %s', (_theme, vars) => {
  it('body text clears AA on its own ground', () => {
    expect(ratio('--foreground', '--background', vars)).toBeGreaterThanOrEqual(AA);
    expect(ratio('--card-foreground', '--card', vars)).toBeGreaterThanOrEqual(AA);
    expect(ratio('--popover-foreground', '--popover', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the secondary text voice clears AA on page, card and the raised surface', () => {
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--muted-foreground', ground, vars)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the faint tier clears AA on page, card and the raised surface', () => {
    // `--muted` is the ground this tier lands on most often: it is the fill of
    // every badge and chip, and it is where the Forms value was re-authored.
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--faint', ground, vars)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the accent as LETTERS clears AA on page and card', () => {
    // 88 `text-primary` call sites resolve here. This is the assertion that fails
    // loudest if someone flattens the light block back into a mirror of the dark.
    expect(ratio('--primary-ink', '--background', vars)).toBeGreaterThanOrEqual(AA);
    expect(ratio('--primary-ink', '--card', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the accent as LINES clears 3:1 on page, card and the raised surface', () => {
    // The muted wash matters: a selected nav row sits inside it, not on the page
    // behind it, and that is the one ground an earlier value failed on.
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--primary-edge', ground, vars)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('the accent fill carries its own label at AA', () => {
    expect(ratio('--primary-foreground', '--primary', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the destructive voice clears AA everywhere it paints', () => {
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--destructive', ground, vars)).toBeGreaterThanOrEqual(AA);
    }
    expect(ratio('--destructive-foreground', '--destructive', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the form-control edge clears 3:1 over card and over page', () => {
    // The decorative hairline is deliberately NOT asked to carry this; a text
    // field's border is the only thing saying "you can type here", which is the
    // WCAG 1.4.11 case. `--input` is why it stopped being the same value.
    expect(ratio('--input', '--card', vars)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(ratio('--input', '--background', vars)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it('the constant brand tile carries its foreground at AA', () => {
    // This pair does not flip with the theme — see `--brand-ink` in tokens.css —
    // so it has to clear on both.
    expect(ratio('--brand-ink-foreground', '--brand-ink', vars)).toBeGreaterThanOrEqual(AA);
  });
});

describe('token sheet structure', () => {
  it('the light block and the prefers-color-scheme block are value-for-value identical', () => {
    // Both apply at once when light is pinned, so a token that lands in only one
    // of them is the hardest kind of theme bug to notice by eye.
    expect(Object.keys(PREFERS).sort()).toEqual(Object.keys(LIGHT).sort());
    expect(PREFERS).toEqual(LIGHT);
    // Plain properties too, not just tokens. `color-scheme` is the one the sheet
    // declares today, and it slipped past this check while it read `--*` alone —
    // so the check now covers the whole declaration, not the instance that
    // exposed the gap.
    expect(plainDeclarations(PREFERS_BODY)).toEqual(plainDeclarations(LIGHT_BODY));
  });

  it('every theme block tells the browser which half it is on', () => {
    // `color-scheme` is the one part of a theme no token can carry: it is what
    // the USER AGENT reads to paint the things it owns — `<select>` popups, the
    // internals of `<input type='date'>`, autofill, the default scrollbar, the
    // canvas behind an overscroll bounce. A theme block without it renders the
    // browser's own chrome for the OTHER palette.
    //
    // Asserted per block by value, because the parity check above only proves
    // the two LIGHT blocks agree with each other — it would be equally happy if
    // both said `dark`.
    expect(plainDeclarations(BASE_BODY)['color-scheme']).toBe('dark');
    expect(plainDeclarations(LIGHT_BODY)['color-scheme']).toBe('light');
    expect(plainDeclarations(PREFERS_BODY)['color-scheme']).toBe('light');
  });

  it('the accent is one value on dark, so the rim is invisible there', () => {
    // The whole ink/edge machinery is a no-op on the theme users see today. If
    // this ever fails, the dark theme has grown a visible rim on every fill.
    expect(toHex(resolve('--primary-ink', BASE))).toBe(toHex(resolve('--primary', BASE)));
    expect(toHex(resolve('--primary-edge', BASE))).toBe(toHex(resolve('--primary', BASE)));
  });

  it('the accent is composed from channels, never written as a literal', () => {
    for (const token of ['--primary', '--primary-ink', '--primary-edge']) {
      expect(BASE[token]).toMatch(/^hsl\(/);
    }
    expect(BASE['--acc-h']).toBeDefined();
    expect(BASE['--acc-s']).toBeDefined();
    expect(BASE['--acc-l']).toBeDefined();
  });
});
