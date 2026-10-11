/**
 * The design language's contrast law, asserted over the token sheet that ships.
 *
 * This spec parses `src/tokens.css` itself rather than a TypeScript mirror of the
 * palette, because a mirror is a second source of truth for colour and the whole
 * point of the sheet is that there is one. It composites the `rgba()` hairline and
 * input edge over the grounds they actually sit on, so what is measured is the
 * colour a viewer sees and not the string a developer typed.
 *
 * Four palettes are measured: the product's dark and light themes (plus the
 * `prefers-color-scheme` mirror of light), and the two BOOKING GROUNDS a host's
 * page paints on. The booking grounds are also pinned value for value, because
 * their job is to never move (see "The booking page is not the product" in the
 * sheet's header).
 *
 * The ratios use the engine's own `contrastRatio`, so the sheet and the engine can
 * never disagree about what 4.5:1 means. Note that `contrastRatio` rounds to
 * NEAREST: that slack is accepted here (see below) and nowhere that decides;
 * `accentCanvasContrast` truncates precisely because the studio acts on it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { contrastRatio } from './branding';

/* `contrastRatio` rounds to one decimal (it exists to drive a UI readout), so a
   true 4.45:1 reports as 4.5 and clears this bar. That 1% of slack is accepted
   rather than worked around: using the engine's own function is the point of this
   spec, and every value the sheet ships sits clear of the boundary. If a future
   token lands inside 0.05 of a threshold, tighten the token rather than the
   assertion. */
const AA = 4.5; // WCAG 1.4.3: body text.
const NON_TEXT = 3; // WCAG 1.4.11: anything that identifies a control or its state.

const TOKENS_CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/* The type scale and radius ladder are NOT asserted here. They are mapped in the
   web app's `@theme inline` block, and reading that file from a package spec would
   make `@slate/shared` depend on `apps/web`, the one direction ARCHITECTURE.md
   forbids outright ("nothing depends on an app"). */

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
 * The PLAIN (non-custom) property declarations in a rule body, the mirror of
 * `declarations()` above, which reads `--*` only. `color-scheme` is a plain
 * property and decides what the BROWSER paints for itself, so a parity check that
 * reads custom properties alone is blind to half of what a theme declares.
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
const BP_DARK_BODY = ruleBody(sheet, ".bp-ground[data-theme='dark']");
const BP_LIGHT_BODY = ruleBody(sheet, ".bp-ground[data-theme='light']");
const BASE = declarations(BASE_BODY);
const LIGHT = declarations(LIGHT_BODY);
const PREFERS = declarations(PREFERS_BODY);
const BP_DARK = declarations(BP_DARK_BODY);
const BP_LIGHT = declarations(BP_LIGHT_BODY);

/**
 * A theme is the base declarations with that theme's overrides applied. A booking
 * ground sits inside a document that already resolved the base, so it is the
 * base plus its own block; the product's light block is NOT under it, because the
 * ground redeclares every role it paints.
 */
const PRODUCT_THEMES: Record<string, Record<string, string>> = {
  dark: BASE,
  light: { ...BASE, ...LIGHT },
  'prefers-color-scheme: light': { ...BASE, ...PREFERS },
};
const BOOKING_GROUNDS: Record<string, Record<string, string>> = {
  'booking ground, dark': { ...BASE, ...BP_DARK },
  'booking ground, light': { ...BASE, ...BP_LIGHT },
};
const ALL_THEMES = { ...PRODUCT_THEMES, ...BOOKING_GROUNDS };

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

  // A token that is another token (`--focus: var(--primary-edge)`) paints as it.
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (alias) return resolve(alias[1], vars);

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

/** A token as it actually paints on a ground, translucency composited away. */
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

describe.each(Object.entries(ALL_THEMES))('token sheet contrast law: %s', (_theme, vars) => {
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
    // every badge and chip.
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--faint', ground, vars)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('the primary as LETTERS clears AA on page and card', () => {
    expect(ratio('--primary-ink', '--background', vars)).toBeGreaterThanOrEqual(AA);
    expect(ratio('--primary-ink', '--card', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the primary as LINES clears 3:1 on page, card and the raised surface', () => {
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--primary-edge', ground, vars)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('the primary fill carries its own label at AA', () => {
    expect(ratio('--primary-foreground', '--primary', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('the focus ring clears 3:1 on page, card and the raised surface', () => {
    for (const ground of ['--background', '--card', '--muted']) {
      expect(ratio('--focus', ground, vars)).toBeGreaterThanOrEqual(NON_TEXT);
    }
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
    // WCAG 1.4.11 case. `--input` is why it is not the same value.
    expect(ratio('--input', '--card', vars)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(ratio('--input', '--background', vars)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it('the constant brand tile carries its foreground at AA', () => {
    expect(ratio('--brand-ink-foreground', '--brand-ink', vars)).toBeGreaterThanOrEqual(AA);
  });
});

describe.each(Object.entries(PRODUCT_THEMES))('the signal and the data channel: %s', (_theme, vars) => {
  it('the signal fill carries ink at AA, and never white', () => {
    expect(ratio('--signal-foreground', '--signal', vars)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio('#ffffff', over('--signal', '--signal', vars))).toBeLessThan(AA);
  });

  it('the signal edge clears 3:1 on page and card', () => {
    for (const ground of ['--background', '--card']) {
      expect(ratio('--signal-edge', ground, vars)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it('the signal and warning as LETTERS clear AA on page and card', () => {
    for (const ground of ['--background', '--card']) {
      expect(ratio('--signal-ink', ground, vars)).toBeGreaterThanOrEqual(AA);
      expect(ratio('--warning-ink', ground, vars)).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('token sheet structure', () => {
  it('the light block and the prefers-color-scheme block are value-for-value identical', () => {
    // Both apply at once when light is pinned, so a token that lands in only one
    // of them is the hardest kind of theme bug to notice by eye.
    expect(Object.keys(PREFERS).sort()).toEqual(Object.keys(LIGHT).sort());
    expect(PREFERS).toEqual(LIGHT);
    expect(plainDeclarations(PREFERS_BODY)).toEqual(plainDeclarations(LIGHT_BODY));
  });

  it('every theme block tells the browser which half it is on', () => {
    // `color-scheme` is the one part of a theme no token can carry: it is what
    // the USER AGENT reads to paint the things it owns. Asserted per block by
    // value, because the parity check above would be equally happy if both
    // light blocks said `dark`.
    expect(plainDeclarations(BASE_BODY)['color-scheme']).toBe('dark');
    expect(plainDeclarations(LIGHT_BODY)['color-scheme']).toBe('light');
    expect(plainDeclarations(PREFERS_BODY)['color-scheme']).toBe('light');
    expect(plainDeclarations(BP_DARK_BODY)['color-scheme']).toBe('dark');
    expect(plainDeclarations(BP_LIGHT_BODY)['color-scheme']).toBe('light');
  });

  it('ink does the work: on both product themes the primary IS the ink of that theme', () => {
    // The primary action and the selected state are the text colour, not a brand
    // colour. If this fails, a saturated colour has been put back on the primary.
    for (const vars of Object.values(PRODUCT_THEMES)) {
      expect(toHex(resolve('--primary', vars))).toBe(toHex(resolve('--foreground', vars)));
      expect(toHex(resolve('--primary-ink', vars))).toBe(toHex(resolve('--primary', vars)));
      expect(toHex(resolve('--primary-edge', vars))).toBe(toHex(resolve('--primary', vars)));
    }
  });

  it('green is rationed to one token family: no other product token is saturated', () => {
    // Saturation in HSL terms, above which a colour reads as a hue rather than a
    // grey. The signal, the warning and the destructive red are the only ones
    // allowed past it; anything else that crosses is a new colour on the page.
    const ALLOWED = new Set([
      '--signal',
      '--signal-edge',
      '--signal-ink',
      '--focus',
      '--ring',
      '--warning',
      '--warning-ink',
      '--destructive',
    ]);
    for (const vars of Object.values(PRODUCT_THEMES)) {
      for (const token of Object.keys(vars)) {
        if (ALLOWED.has(token) || token.startsWith('--sp-') || token.startsWith('--radius')) continue;
        const rgb = resolve(token, vars);
        const max = Math.max(rgb.r, rgb.g, rgb.b);
        const min = Math.min(rgb.r, rgb.g, rgb.b);
        expect(max - min, `${token} is saturated`).toBeLessThan(24);
      }
    }
  });

  it('the booking ground keeps its focus ring on the host accent', () => {
    expect(BP_DARK['--focus']).toBe('var(--primary-edge)');
    expect(BP_LIGHT['--focus']).toBe('var(--primary-edge)');
  });
});

/* The booking ground, pinned. These are the values every live booking page was
   designed against before the dForms language, and the public-markup snapshots
   only prove the MARKUP did not move: colour lives here. A change to any value in
   these two blocks restyles live pages, so it has to change this literal too, in
   a PR that says so. */
describe('the booking ground does not move', () => {
  it('dark', () => {
    expect(BP_DARK).toEqual({
      '--background': '#0a0c0e',
      '--foreground': '#e8edf2',
      '--card': '#101418',
      '--card-foreground': '#e8edf2',
      '--popover': '#0d1013',
      '--popover-foreground': '#e8edf2',
      '--primary': 'hsl(68 76% 61%)',
      '--primary-foreground': '#0c0e07',
      '--primary-edge': 'hsl(68 76% 61%)',
      '--primary-ink': 'hsl(68 76% 61%)',
      '--secondary': '#7d8fa1',
      '--secondary-foreground': '#0a0c0e',
      '--muted': '#161c22',
      '--muted-foreground': '#93a1ae',
      '--accent': '#161c22',
      '--accent-foreground': '#e8edf2',
      '--faint': '#758592',
      '--destructive': '#ff3b30',
      '--destructive-foreground': '#0a0c0e',
      '--border': 'rgba(148, 170, 190, 0.16)',
      '--input': 'rgba(148, 170, 190, 0.58)',
      '--ring': 'hsl(68 76% 61% / 0.45)',
      '--focus': 'var(--primary-edge)',
      '--radius': '0.625rem',
      '--radius-monitor': '16px',
    });
  });

  it('light', () => {
    expect(BP_LIGHT).toEqual({
      '--background': '#f4f6f8',
      '--foreground': '#0d1013',
      '--card': '#ffffff',
      '--card-foreground': '#0d1013',
      '--popover': '#ffffff',
      '--popover-foreground': '#0d1013',
      '--primary': 'hsl(68 76% 61%)',
      '--primary-foreground': '#0c0e07',
      '--primary-edge': 'hsl(68 76% 28%)',
      '--primary-ink': 'hsl(68 76% 26%)',
      '--secondary': '#5a6875',
      '--secondary-foreground': '#ffffff',
      '--muted': '#dfe4ea',
      '--muted-foreground': '#55636f',
      '--accent': '#dfe4ea',
      '--accent-foreground': '#0d1013',
      '--faint': '#586470',
      '--destructive': '#c2261c',
      '--destructive-foreground': '#ffffff',
      '--border': 'rgba(20, 32, 44, 0.22)',
      '--input': 'rgba(20, 32, 44, 0.5)',
      '--ring': 'hsl(68 76% 28%)',
      '--focus': 'var(--primary-edge)',
      '--radius': '0.625rem',
      '--radius-monitor': '16px',
    });
  });
});

// --- The law, on translucent grounds ---------------------------------------

/* Everything above measures a SOLID token on a SOLID ground. The admin is not
   built that way: a status chip is `bg-signal/20` under `text-foreground`, an
   error banner is `bg-destructive/10` under `text-destructive`, a control strip is
   `bg-muted/40` under `text-muted-foreground`. Tailwind's `/N` modifier makes each
   of those a DIFFERENT colour from the token it names, so each is measured here.

   The alphas listed are the ones the screens paint. A new wash at a new opacity
   means a new entry here; that is the point of the list. */

/** A token at `alpha`, composited over a ground token, as the viewer sees it. */
function washOver(
  token: string,
  alpha: number,
  ground: string,
  vars: Record<string, string>,
): string {
  const fg = resolve(token, vars);
  const bg = resolve(ground, vars);
  const a = fg.a * alpha;
  return toHex({
    r: bg.r + (fg.r - bg.r) * a,
    g: bg.g + (fg.g - bg.g) * a,
    b: bg.b + (fg.b - bg.b) * a,
    a: 1,
  });
}

/** A token painted onto an already-composited hex: the second layer of a wash. */
function onPainted(token: string, paintedHex: string, vars: Record<string, string>): string {
  const fg = resolve(token, vars);
  if (fg.a >= 1) return toHex(fg);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(paintedHex);
  if (!m) throw new Error(`not a composited hex: ${paintedHex}`);
  const bg = {
    r: parseInt(m[1]!, 16),
    g: parseInt(m[2]!, 16),
    b: parseInt(m[3]!, 16),
  };
  return toHex({
    r: bg.r + (fg.r - bg.r) * fg.a,
    g: bg.g + (fg.g - bg.g) * fg.a,
    b: bg.b + (fg.b - bg.b) * fg.a,
    a: 1,
  });
}

/** The ratio of a solid token against a WASHED ground, both composited first. */
function ratioOnWash(
  token: string,
  wash: [string, number],
  ground: string,
  vars: Record<string, string>,
): number {
  const painted = washOver(wash[0], wash[1], ground, vars);
  return contrastRatio(onPainted(token, painted, vars), painted);
}

/** Every ground a wash lands on in the admin: the page, and a card on it. */
const WASH_GROUNDS = ['--background', '--card'] as const;

describe.each(Object.entries(PRODUCT_THEMES))('the law on translucent grounds: %s', (_theme, vars) => {
  it('the primary wash carries primary letters at AA', () => {
    // The "invited" pill on Members, the "connected" badge on Integrations, and
    // the studio's unsaved-changes chip. `text-primary` resolves to
    // `--primary-ink` (globals.css overrides the utility), so that is measured.
    for (const ground of WASH_GROUNDS) {
      for (const alpha of [0.1, 0.15]) {
        expect(ratioOnWash('--primary-ink', ['--primary', alpha], ground, vars)).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('a status chip wash carries ink at AA', () => {
    // `StatusChip`: `bg-signal/20` (confirmed), `bg-warning/20` (pending) and
    // `bg-muted` (cancelled), each under `text-foreground`.
    for (const ground of WASH_GROUNDS) {
      for (const wash of ['--signal', '--warning'] as const) {
        expect(ratioOnWash('--foreground', [wash, 0.2], ground, vars)).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('the destructive wash carries destructive letters at AA', () => {
    for (const ground of WASH_GROUNDS) {
      for (const alpha of [0.05, 0.1]) {
        expect(
          ratioOnWash('--destructive', ['--destructive', alpha], ground, vars),
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('the raised-deck washes carry both text voices at AA', () => {
    for (const ground of WASH_GROUNDS) {
      for (const alpha of [0.3, 0.4, 0.5, 0.6]) {
        expect(
          ratioOnWash('--muted-foreground', ['--muted', alpha], ground, vars),
        ).toBeGreaterThanOrEqual(AA);
        expect(ratioOnWash('--foreground', ['--muted', alpha], ground, vars)).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('a page wash inside a card carries both text voices at AA', () => {
    expect(
      ratioOnWash('--muted-foreground', ['--background', 0.6], '--card', vars),
    ).toBeGreaterThanOrEqual(AA);
    expect(ratioOnWash('--foreground', ['--background', 0.6], '--card', vars)).toBeGreaterThanOrEqual(AA);
  });

  it('a SOLID line drawn around a washed panel still clears 3:1', () => {
    for (const ground of WASH_GROUNDS) {
      for (const alpha of [0.05, 0.1, 0.15]) {
        expect(
          ratioOnWash('--primary-edge', ['--primary', alpha], ground, vars),
        ).toBeGreaterThanOrEqual(NON_TEXT);
        expect(
          ratioOnWash('--destructive', ['--destructive', alpha], ground, vars),
        ).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });
});

/* The spacing scale (SP, #147).

   The header of this file explains why the type and radius scales are NOT
   asserted here: they are mapped in the web app's `@theme inline` block, and
   reading that from a package spec would make `@slate/shared` depend on an app.
   Spacing is the exception on both halves of that argument. It is declared in
   THIS sheet, so reading it creates no such dependency; and unlike a crossed type
   step, an off-grid spacing step is invisible on screen: it reads as "this row
   is slightly off" and survives every review, which is exactly how 74 distinct
   values accumulated across 17 roles before the scale existed.

   The roles are read OUT of the sheet rather than listed here, so a step added
   later is grid-checked without anyone remembering to add it to a literal. The
   literal below is the pin: it asserts WHICH roles exist, so a rename or a
   silent removal fails too. */
describe('the spacing scale', () => {
  const SPACING_ROLES = [
    'tight',
    'inline',
    'field',
    'card',
    'group',
    'section',
    'page-x',
    'page-x-wide',
    'page-y',
    'control-h',
    'control-x',
  ] as const;

  /* `sheet`, not `TOKENS_CSS`: comments in this file quote CSS, so a `--sp-…:`
     inside prose would otherwise be read as a declaration. */
  const DECLARED = [...sheet.matchAll(/--sp-([a-z-]+)\s*:/g)].map((m) => m[1]);

  /** `--sp-card: 1rem;` → 16. Throws rather than returning NaN: a token that
   *  cannot be read is a failure to report, not a value to compare. */
  function pxOf(role: string): number {
    const m = sheet.match(new RegExp(`--sp-${role}:\\s*([\\d.]+)rem\\s*;`));
    if (!m) throw new Error(`--sp-${role} is missing from the sheet, or is not in rem`);
    return Number(m[1]) * 16;
  }

  it('declares exactly the roles the scale claims, and no others', () => {
    expect([...new Set(DECLARED)].sort()).toEqual([...SPACING_ROLES].sort());
  });

  it('lands every declared step on the 4px grid', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    for (const role of DECLARED) {
      expect(pxOf(role) % 4, `--sp-${role} is ${pxOf(role)}px`).toBe(0);
    }
  });

  it('keeps the content roles in ascending order, so "looser" means one thing', () => {
    const ladder = ['tight', 'inline', 'field', 'card', 'group', 'section'] as const;
    const values = ladder.map(pxOf);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size, 'two roles share a value, so the ladder has a dead rung').toBe(
      values.length,
    );
  });

  it('keeps the responsive gutter widening, never narrowing, from the floor up', () => {
    expect(pxOf('page-x-wide')).toBeGreaterThan(pxOf('page-x'));
  });

  it('keeps the tap target at the 44px accessibility floor (R28)', () => {
    expect(pxOf('control-h')).toBeGreaterThanOrEqual(44);
  });

  it('is theme-independent: every step is declared on a bare :root', () => {
    // Walk the sheet tracking the selector of the block currently open. A regex
    // over "the text after the last @media" would also match a block placed at
    // the end of the file: a test that can only pass by accident.
    expect(DECLARED.length).toBeGreaterThan(0);
    const lines = sheet.split('\n');
    const open: string[] = [];
    let pending = '';
    for (const line of lines) {
      const decl = line.match(/^\s*(--sp-[a-z-]+):/);
      if (decl) {
        // `:root` ALONE, not a selector list that happens to contain it. The
        // base colour rule is `:root, [data-theme='dark']`, and a spacing token
        // parked there would simply not exist inside a `[data-theme='light']`
        // subtree, and the booking page's own canvas is exactly such a subtree.
        const selector = open.at(-1) ?? '';
        expect(
          selector,
          `${decl[1]} is declared under "${selector}"; spacing belongs on :root alone`,
        ).toBe(':root');
      }
      if (line.includes('{')) {
        // `stripComments` blanks a comment's body but leaves its delimiters, so
        // anything up to the last `*/` on the way to the brace is not selector.
        const raw = `${pending} ${line.slice(0, line.indexOf('{'))}`;
        const selector = raw.includes('*/') ? raw.slice(raw.lastIndexOf('*/') + 2) : raw;
        open.push(selector.trim());
        pending = '';
      } else if (line.includes('}')) {
        open.pop();
        pending = '';
      } else if (line.trim()) {
        // A selector list can span lines; carry it to the line with the brace.
        pending = open.length === 0 ? line : '';
      }
    }
  });
});
