/**
 * Booking-page branding engine (ported verbatim from the original R25 util).
 * The host picks ONE accent color; we clamp it to an AA-safe range and derive
 * everything else. The public page and the studio live-preview share these, so
 * preview == production. The 9 style axes + 4 theme presets are the exact values
 * from the previous version — radii/spacing/font stacks must match.
 */

// --- The 9 style axes (exact unions) --------------------------------------
export type BookingPageTemplate = 'classic' | 'split' | 'banded';
export type BookingCardStyle = 'outline' | 'elevated' | 'filled';
export type BookingCorners = 'sharp' | 'soft' | 'round';
export type BookingButtons = 'rounded' | 'pill' | 'square';
export type BookingDensity = 'comfortable' | 'compact';
export type BookingFont = 'sans' | 'rounded' | 'serif';
export type BookingSlotLayout = 'grid' | 'list';
export type BookingDayGroup = 'flat' | 'boxed';
export type BookingSlotSelect = 'soft' | 'solid';

export interface PublicBranding {
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  accentColor: string;
  template: BookingPageTemplate;
  landingEnabled: boolean;
  defaultEventSlug: string | null;
  cardStyle: BookingCardStyle;
  corners: BookingCorners;
  buttons: BookingButtons;
  density: BookingDensity;
  font: BookingFont;
  slotLayout: BookingSlotLayout;
  dayGroup: BookingDayGroup;
  slotSelect: BookingSlotSelect;
}

/** DS primary lime — the default accent when a host hasn't chosen one. */
export const DEFAULT_ACCENT = '#cbe84f';

/**
 * The ground a branded surface paints on. ADR 0004 gives the booking page a
 * theme of its own, so a colour is never "legible" in the abstract — only
 * legible *against a canvas*. Every clamp and derivation below takes one, and
 * the value is the same union the stored `theme` axis will carry, so the axis
 * flows straight in without a translation step.
 */
export type BrandCanvas = 'dark' | 'light';

/**
 * The ground each theme is measured against — deliberately the STRICTER of the
 * page and card grounds in both directions, so an accent that clears the canvas
 * clears a card too.
 *
 * `dark` stays `#222222`, the value this engine has always clamped against. The
 * real dark page is `#0a0c0e` and its card `#101418` (tokens.css), both darker,
 * i.e. both easier for a colour travelling toward white. Keeping the old value
 * is what guarantees no already-saved accent moves the day this ships.
 *
 * `light` is the light `--background`, `#f4f6f8`. Its card is `#ffffff`, which
 * is the easier ground for a colour travelling toward black.
 */
export const CANVAS_HEX: Record<BrandCanvas, string> = {
  dark: '#222222',
  light: '#f4f6f8',
};

/** WCAG 1.4.11: a fill or rim that identifies a control needs 3:1 on its ground. */
const MIN_ACCENT_CONTRAST = 3;
/** WCAG 1.4.3 AA: the accent used as LETTERS needs 4.5:1 on its ground. */
const MIN_INK_CONTRAST = 4.5;
/** The rim and focus outline carry the same non-text floor as the fill. */
const MIN_EDGE_CONTRAST = 3;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb | null {
  const clean = hex.trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The WCAG contrast ratio between two hex colors, rounded to one decimal.
 *
 * The math was already here, private, serving `clampAccent`. It is exported
 * because the token sheet's contrast law is now a unit test (`tokens.spec.ts`)
 * that measures the shipped `tokens.css` rather than a TypeScript mirror of it,
 * and that test needs the same arithmetic the engine clamps with — one
 * implementation, so a palette cannot pass the test and fail the engine.
 * Returns 0 if either color fails to parse.
 */
export function contrastRatio(a: string, b: string): number {
  return Math.round(contrastRatioExact(a, b) * 10) / 10;
}

/**
 * The same ratio, unrounded.
 *
 * `contrastRatio` rounds because it drives a UI readout, and `tokens.spec.ts`
 * accepts that slack deliberately: the sheet's values are hand-tuned and sit
 * well clear of every threshold. The engine's OWN output does not — the clamp
 * below stops on the first value that crosses its floor, so its results park
 * ON the boundary, where a rounded 2.98 reports as 3.0. Anything asserting a
 * law about a generated colour has to measure it exactly.
 * Returns 0 if either color fails to parse.
 */
export function contrastRatioExact(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 0;
  return contrast(ca, cb);
}

function mix(rgb: Rgb, target: Rgb, amount: number): Rgb {
  return {
    r: rgb.r + (target.r - rgb.r) * amount,
    g: rgb.g + (target.g - rgb.g) * amount,
    b: rgb.b + (target.b - rgb.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * Which pole a colour travels toward to become legible on a given canvas. This
 * is the whole of "bidirectional": on the console you lighten, on paper you
 * darken. The one-directional version lightened in BOTH cases, which is why a
 * host's navy came out of the engine as a washed pale blue and then disappeared
 * on a light booking page.
 */
const CANVAS_TARGET: Record<BrandCanvas, Rgb> = { dark: WHITE, light: BLACK };

/**
 * Narrow whatever actually arrived to a canvas we have a ground for.
 *
 * A runtime guard, not a type concern. B2 reads this axis off the
 * `booking_page_style` jsonb, where an old row, a hand-edited one, or an embed
 * URL parameter can carry `'Dark'`, `null`, or nothing at all — and an unknown
 * key here would index to `undefined` and throw inside the clamp. A public
 * booking page must not 500 because a stored theme string was capitalised; it
 * falls back to the ground the page has always rendered on.
 */
function safeCanvas(canvas: BrandCanvas): BrandCanvas {
  return canvas === 'light' || canvas === 'dark' ? canvas : 'dark';
}

/** Snap to the 8-bit channels a hex can actually express. */
function quantize({ r, g, b }: Rgb): Rgb {
  const channel = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
  return { r: channel(r), g: channel(g), b: channel(b) };
}

/**
 * Step a colour toward its canvas's pole, 0.12 at a time, until it clears `min`
 * against that canvas.
 *
 * The test is on the QUANTIZED candidate, not on the running float. A step
 * overshoots the floor by as little as 2e-7, and rounding to 8-bit channels then
 * moves the colour up to half a step back toward the ground — so testing the
 * float and shipping the hex let values out that measured 2.98:1 and 4.49:1. It
 * also broke idempotence: feeding a returned colour back in stepped it again,
 * and since the studio saves a clamped accent that the public page clamps a
 * second time, the two surfaces drifted apart — the exact "preview == prod"
 * break this engine exists to prevent. Measuring what is actually returned
 * makes the floor true, the function idempotent, and `accentEdge` equal to the
 * clamp by construction rather than by luck.
 *
 * Capped at 20 steps. Instrumented over the full sRGB cube the worst case uses
 * 8, so the cap never binds; it is a guard, not a budget.
 */
function towardLegible(rgb: Rgb, canvas: BrandCanvas, min: number): Rgb {
  const c = safeCanvas(canvas);
  const ground = parseHex(CANVAS_HEX[c])!;
  const target = CANVAS_TARGET[c];
  let exact = rgb;
  let shipped = quantize(exact);
  for (let i = 0; i < 20 && contrast(shipped, ground) < min; i++) {
    exact = mix(exact, target, 0.12);
    shipped = quantize(exact);
  }
  return shipped;
}

/**
 * Clamp a host-chosen accent into the legible range for `canvas`, in whichever
 * direction that canvas requires. This is the accent as a FILL: 3:1 so the
 * shape of a primary control is identifiable on its ground.
 *
 * An unparseable hex falls back to the DS accent — itself clamped, because the
 * lime is 1.2:1 on paper and handing a light page an invisible accent is not a
 * fallback.
 *
 * Note this clamps the FILL, where the token sheet deliberately does not: on
 * light, `--primary` keeps the bright lime and only the edge carries the 3:1.
 * That trade is available to the PRODUCT because there is one product accent
 * and it was hand-tuned against both grounds. A host's accent is arbitrary — no
 * one checked that their pale yellow reads as a button on paper — so the engine
 * keeps the safety net it has always had and moves the fill. The consequence is
 * visible and intended: a very light brand colour comes back darker on a light
 * booking page, rather than coming back as an invisible button.
 */
export function clampAccent(hex: string, canvas: BrandCanvas): string {
  return toHex(clampRgb(hex, canvas));
}

/**
 * The clamp, before it becomes a string. Every derivation below composes on
 * this rather than re-parsing `clampAccent`'s output: a hex round-trip between
 * two steps is what let a colour lose up to half a channel step between the
 * check that approved it and the value that shipped.
 */
function clampRgb(hex: string, canvas: BrandCanvas): Rgb {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  return towardLegible(rgb, canvas, MIN_ACCENT_CONTRAST);
}

/**
 * The host's accent as LETTERS on `canvas` — `--primary-ink`.
 *
 * Text carries AA (4.5:1), a full step above what the fill needs, so this is
 * not the same colour as the fill on either theme: a lime that is a superb
 * 14:1 on the console is 1.3:1 on paper, and `text-primary` is re-pointed at
 * this token globally (globals.css). Without it every accent-coloured link on a
 * branded page falls back to the PRODUCT's lime.
 */
export function accentInk(hex: string, canvas: BrandCanvas): string {
  return toHex(towardLegible(clampRgb(hex, canvas), canvas, MIN_INK_CONTRAST));
}

/**
 * The host's accent as a RIM or focus outline on `canvas` — `--primary-edge`.
 *
 * globals.css rims every accent fill with this and draws the focus ring in it.
 * Stated as its own law rather than folded into `clampAccent`: the two floors
 * are equal today, so this returns the clamped accent unchanged — but the edge
 * answers to WCAG 1.4.11 about a *boundary* while the fill answers about a
 * *shape*, and a future retune of either must not silently move the other.
 */
export function accentEdge(hex: string, canvas: BrandCanvas): string {
  return toHex(towardLegible(clampRgb(hex, canvas), canvas, MIN_EDGE_CONTRAST));
}

/** The label color that reads on top of the accent (black or white). */
export function onAccent(hex: string): string {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  return contrast(rgb, BLACK) >= contrast(rgb, WHITE) ? '#1a1a1c' : '#fafafa';
}

export function accentLabelContrast(hex: string, canvas: BrandCanvas): number {
  const accent = parseHex(clampAccent(hex, canvas))!;
  const label = parseHex(onAccent(clampAccent(hex, canvas)))!;
  return Math.round(contrast(accent, label) * 10) / 10;
}

/** True when the host's raw pick had to be nudged to stay readable on `canvas`
 *  — lighter on the console, darker on paper. */
export function accentWasAdjusted(hex: string, canvas: BrandCanvas): boolean {
  const parsed = parseHex(hex);
  if (!parsed) return false;
  return toHex(parsed).toLowerCase() !== clampAccent(hex, canvas).toLowerCase();
}

export function accentVars(rawAccent: string, canvas: BrandCanvas): Record<string, string> {
  return accentVarsFrom(clampRgb(rawAccent, canvas), canvas);
}

/** `accentVars` given an ALREADY-clamped colour, so a caller that has one does
 *  not clamp it a second time. */
function accentVarsFrom(clamped: Rgb, canvas: BrandCanvas): Record<string, string> {
  const accent = toHex(clamped);
  return {
    '--accent': accent,
    '--accent-contrast': onAccent(accent),
    // Hover travels the same way the clamp does. Mixing toward white on a light
    // canvas would make the hover state FADE toward the page it sits on, i.e.
    // the one interaction that must read as "more" would read as less.
    '--accent-hover': toHex(mix(clamped, CANVAS_TARGET[safeCanvas(canvas)], 0.16)),
    '--accent-soft': `color-mix(in srgb, ${accent} 16%, transparent)`,
    // Composited against `--background`, so the wash follows whatever theme the
    // surface resolved to rather than assuming one.
    '--accent-wash': `color-mix(in srgb, ${accent} 22%, var(--background))`,
  };
}

/**
 * Every custom property a branded surface must set for `canvas` — the accent's
 * own vars plus the five PRODUCT accent tokens the token sheet defines.
 *
 * Emitting the product tokens is the point. `globals.css` re-points the
 * `text-primary` utility at `--primary-ink` and rims every `bg-primary` with
 * `--primary-edge`; both resolve from the product palette unless a branded
 * surface overrides them, so a page that sets only `--primary` quietly paints
 * the host's links and rims in OUR lime (ADR 0004).
 *
 * One function, consumed by both the public shell and the studio preview, so
 * "preview == production" is a property of the code rather than a convention
 * two call sites have to keep agreeing on.
 */
export function brandVars(rawAccent: string, canvas: BrandCanvas): Record<string, string> {
  // Clamped ONCE, and every token below derived from that one value. Deriving
  // some of them by re-clamping a string made the block able to disagree with
  // itself — `--primary` from one clamp, `--primary-edge` from a second.
  const clamped = clampRgb(rawAccent, canvas);
  const accent = toHex(clamped);
  const edge = toHex(towardLegible(clamped, canvas, MIN_EDGE_CONTRAST));
  return {
    ...accentVarsFrom(clamped, canvas),
    '--primary': accent,
    '--primary-foreground': onAccent(accent),
    '--primary-ink': toHex(towardLegible(clamped, canvas, MIN_INK_CONTRAST)),
    '--primary-edge': edge,
    // The focus outline is drawn with `--primary-edge` (globals.css), so `--ring`
    // has to be the same colour or a focused control gets two different rims.
    '--ring': edge,
  };
}

// --- The 9 axis value maps (exact radii/spacing/font stacks) ---------------
export const DEFAULT_CARD_STYLE: BookingCardStyle = 'outline';
export const DEFAULT_CORNERS: BookingCorners = 'soft';
export const DEFAULT_BUTTONS: BookingButtons = 'rounded';
export const DEFAULT_DENSITY: BookingDensity = 'comfortable';
export const DEFAULT_FONT: BookingFont = 'sans';
export const DEFAULT_SLOT_LAYOUT: BookingSlotLayout = 'grid';
export const DEFAULT_DAY_GROUP: BookingDayGroup = 'flat';
export const DEFAULT_SLOT_SELECT: BookingSlotSelect = 'soft';

const CORNER_RADII: Record<BookingCorners, { card: string; sm: string }> = {
  sharp: { card: '4px', sm: '3px' },
  soft: { card: '16px', sm: '8px' },
  round: { card: '28px', sm: '16px' },
};

const BUTTON_RADII: Record<BookingButtons, string> = {
  rounded: '8px',
  pill: '999px',
  square: '2px',
};

const DENSITY_SPACE: Record<BookingDensity, { pad: string; gap: string; slotPad: string }> = {
  comfortable: { pad: '20px', gap: '12px', slotPad: '12px' },
  compact: { pad: '12px', gap: '8px', slotPad: '8px' },
};

/**
 * The booking page's three font axes. This is a HOST choice about their own
 * page, not product chrome, so the reskin leaves the axis alone — `sans` still
 * means "the product's own face" and a host who picked it keeps whatever that
 * is. Only the fallback name inside the `sans` display stack moved from Poppins
 * to Figtree, so an unbranded page and the product agree on the face they name
 * when `--font-display` is absent.
 */
const FONT_STACKS: Record<BookingFont, { display: string; body: string }> = {
  sans: {
    display: 'var(--font-display, Figtree, ui-sans-serif, system-ui, sans-serif)',
    body: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
  },
  rounded: {
    display: '"SF Pro Rounded", ui-rounded, "Segoe UI", system-ui, sans-serif',
    body: '"SF Pro Rounded", ui-rounded, "Segoe UI", system-ui, sans-serif',
  },
  serif: {
    display: 'Georgia, "Times New Roman", ui-serif, serif',
    body: 'Georgia, "Times New Roman", ui-serif, serif',
  },
};

type WidgetAxes = Pick<PublicBranding, 'corners' | 'density' | 'font' | 'buttons'>;

export function widgetStyleVars(b: Partial<WidgetAxes>): Record<string, string> {
  const corners = CORNER_RADII[b.corners ?? DEFAULT_CORNERS];
  const density = DENSITY_SPACE[b.density ?? DEFAULT_DENSITY];
  const font = FONT_STACKS[b.font ?? DEFAULT_FONT];
  return {
    '--bp-radius': corners.card,
    '--bp-radius-sm': corners.sm,
    '--bp-btn-radius': BUTTON_RADII[b.buttons ?? DEFAULT_BUTTONS],
    '--bp-pad': density.pad,
    '--bp-gap': density.gap,
    '--bp-slot-pad': density.slotPad,
    '--bp-font-display': font.display,
    '--bp-font-body': font.body,
  };
}

export function brandingStyleVars(b: PublicBranding, canvas: BrandCanvas): Record<string, string> {
  return { ...brandVars(b.accentColor, canvas), ...widgetStyleVars(b) };
}

export function brandingClass(b: PublicBranding): string {
  return brandingClassOf(b);
}

/**
 * Emit the host-class list from just the (possibly partial) style axes — the
 * bridge that makes the 5 class-driven axes reach the DOM. Pair with the
 * `.branded-surface` CSS. `template`/`cardStyle`/`slotLayout`/`dayGroup`/
 * `slotSelect` render via these classes; `corners`/`buttons`/`density`/`font`
 * render via the `--bp-*` custom properties (widgetStyleVars).
 */
export function brandingClassOf(
  axes: Partial<
    Pick<PublicBranding, 'template' | 'cardStyle' | 'slotLayout' | 'dayGroup' | 'slotSelect'>
  >,
): string {
  return [
    'branded-surface',
    `tpl-${axes.template ?? 'classic'}`,
    `card-${axes.cardStyle ?? DEFAULT_CARD_STYLE}`,
    `slots-${axes.slotLayout ?? DEFAULT_SLOT_LAYOUT}`,
    `day-${axes.dayGroup ?? DEFAULT_DAY_GROUP}`,
    `sel-${axes.slotSelect ?? DEFAULT_SLOT_SELECT}`,
  ].join(' ');
}

export function defaultBranding(displayName: string, avatarUrl: string | null = null): PublicBranding {
  return {
    displayName,
    bio: null,
    avatarUrl,
    coverUrl: null,
    accentColor: DEFAULT_ACCENT,
    template: 'classic',
    landingEnabled: true,
    defaultEventSlug: null,
    cardStyle: DEFAULT_CARD_STYLE,
    corners: DEFAULT_CORNERS,
    buttons: DEFAULT_BUTTONS,
    density: DEFAULT_DENSITY,
    font: DEFAULT_FONT,
    slotLayout: DEFAULT_SLOT_LAYOUT,
    dayGroup: DEFAULT_DAY_GROUP,
    slotSelect: DEFAULT_SLOT_SELECT,
  };
}

export function monogram(name: string): string {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

// --- Theme presets (studio) — set all 9 axes at once; active theme DERIVED ---
export interface ThemeAxes {
  readonly template: BookingPageTemplate;
  readonly cardStyle: BookingCardStyle;
  readonly corners: BookingCorners;
  readonly buttons: BookingButtons;
  readonly density: BookingDensity;
  readonly font: BookingFont;
  readonly slotLayout: BookingSlotLayout;
  readonly dayGroup: BookingDayGroup;
  readonly slotSelect: BookingSlotSelect;
}

export type BookingTheme = 'minimal' | 'modern' | 'bold' | 'classic';
export const ALL_BOOKING_THEMES: readonly BookingTheme[] = ['minimal', 'modern', 'bold', 'classic'];

export const THEME_PRESETS: Record<BookingTheme, ThemeAxes> = {
  minimal: {
    template: 'split',
    cardStyle: 'outline',
    corners: 'sharp',
    buttons: 'square',
    density: 'compact',
    font: 'sans',
    slotLayout: 'list',
    dayGroup: 'flat',
    slotSelect: 'soft',
  },
  modern: {
    template: 'classic',
    cardStyle: 'outline',
    corners: 'soft',
    buttons: 'rounded',
    density: 'comfortable',
    font: 'sans',
    slotLayout: 'grid',
    dayGroup: 'flat',
    slotSelect: 'soft',
  },
  bold: {
    template: 'banded',
    cardStyle: 'filled',
    corners: 'round',
    buttons: 'pill',
    density: 'comfortable',
    font: 'rounded',
    slotLayout: 'grid',
    dayGroup: 'boxed',
    slotSelect: 'solid',
  },
  classic: {
    template: 'classic',
    cardStyle: 'elevated',
    corners: 'soft',
    buttons: 'rounded',
    density: 'comfortable',
    font: 'serif',
    slotLayout: 'list',
    dayGroup: 'boxed',
    slotSelect: 'soft',
  },
};

/** Which theme the current axes match exactly, or null when fine-tuned ("Custom"). */
export function matchTheme(axes: ThemeAxes): BookingTheme | null {
  return (
    ALL_BOOKING_THEMES.find((theme) => {
      const p = THEME_PRESETS[theme];
      return (
        p.template === axes.template &&
        p.cardStyle === axes.cardStyle &&
        p.corners === axes.corners &&
        p.buttons === axes.buttons &&
        p.density === axes.density &&
        p.font === axes.font &&
        p.slotLayout === axes.slotLayout &&
        p.dayGroup === axes.dayGroup &&
        p.slotSelect === axes.slotSelect
      );
    }) ?? null
  );
}
