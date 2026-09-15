/**
 * Booking-page branding engine (ported verbatim from the original R25 util).
 * The host picks ONE accent color and it is used AS PICKED; everything else is
 * derived from it. The public page and the studio live-preview share these, so
 * preview == production. The 9 style axes + 4 theme presets are the exact values
 * from the previous version — radii/spacing/font stacks must match.
 *
 * The engine used to adjust the accent for contrast. It no longer does: ADR 0004's
 * 2026-09-11 amendment took that decision away from the code and gave it to the
 * host, who owns their brand. The one derived value that KEEPS a floor is
 * `onAccent`, because that is not the host's colour — it is the black-or-white
 * label sitting on top of it, and a host who picks dark green never chose black
 * text on dark green. The studio now reports the contrast number instead of
 * quietly correcting it.
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
  /** The GROUND the other nine axes are drawn on (ADR 0004). Carried here so a
   *  consumer of this type sees all ten axes; `ThemeAxes` below deliberately
   *  stays at nine, because a studio PRESET describes a silhouette and must not
   *  move a host's page between canvases. */
  theme: BrandCanvas;
}

/** DS primary lime — the default accent when a host hasn't chosen one. */
export const DEFAULT_ACCENT = '#cbe84f';

/**
 * The ground a branded surface paints on. ADR 0004 gives the booking page a
 * theme of its own, so a colour is never "legible" in the abstract — only
 * legible *against a canvas*. The engine no longer acts on that (ADR 0004's
 * amendment) but it still REPORTS it, and hover and the accent wash still
 * resolve per ground, so every derivation below still takes one. The value is
 * the same union the stored `theme` axis carries, so the axis flows straight in
 * without a translation step.
 */
export type BrandCanvas = 'dark' | 'light';

/**
 * The ground each theme is measured against — deliberately the STRICTER of the
 * page and card grounds in both directions, so an accent that clears the canvas
 * clears a card too.
 *
 * `dark` stays `#222222`, the value this engine has always measured against. The
 * real dark page is `#0a0c0e` and its card `#101418` (tokens.css), both darker,
 * i.e. both more forgiving for a light colour. Measuring against the stricter of
 * the two is what keeps the studio's warning honest on a card as well as a page.
 *
 * `light` is the light `--background`, `#f4f6f8`. Its card is `#ffffff`, the
 * more forgiving ground for a dark colour.
 */
export const CANVAS_HEX: Record<BrandCanvas, string> = {
  dark: '#222222',
  light: '#f4f6f8',
};

/**
 * WCAG 1.4.11: a fill or rim that identifies a control needs 3:1 on its ground.
 *
 * The engine REPORTS this now rather than enforcing it (ADR 0004 amendment). It
 * is exported because the studio's warning has to fire on the same number this
 * file calls a floor — a threshold typed twice is a threshold that drifts, and
 * the whole substitute for the old clamp is that the host is told accurately.
 *
 * There is no longer an ink or edge floor. Both derivations return the host's
 * colour unchanged, so a second constant would only describe a rule nothing
 * applies; the AA figure a host may need lives in the studio's copy instead.
 */
export const MIN_ACCENT_CONTRAST = 3;

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
 * `contrastRatio` rounds to NEAREST because it drives a UI readout whose values
 * are hand-tuned, and `tokens.spec.ts` accepts that slack deliberately. Nothing
 * that DECIDES may use it: a true 2.98 reports as 3.0, which is how a colour
 * under the floor reads as passing. Anything asserting a law about a colour, or
 * choosing whether to warn about one, has to measure it exactly — see
 * `accentCanvasContrast`, which truncates for exactly this reason.
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
 * Which pole a colour moves toward to read as "more" on a given canvas: on the
 * console you lighten, on paper you darken.
 *
 * This drove the contrast clamp until the ADR 0004 amendment retired it. It
 * survives for the one derivation that still moves a colour on purpose — the
 * HOVER state — where the direction is not about legibility at all: a hover that
 * mixed toward white on paper would fade toward the page it sits on, so the one
 * interaction that must read as "more" would read as less.
 */
const CANVAS_TARGET: Record<BrandCanvas, Rgb> = { dark: WHITE, light: BLACK };

/**
 * Narrow whatever actually arrived to a canvas we have a ground for.
 *
 * A runtime guard, not a type concern. B2 reads this axis off the
 * `booking_page_style` jsonb, where an old row, a hand-edited one, or an embed
 * URL parameter can carry `'Dark'`, `null`, or nothing at all — and an unknown
 * key here would index to `undefined` and throw in any lookup keyed by canvas.
 * A public booking page must not 500 because a stored theme string was
 * capitalised; it falls back to the product's own ground.
 */
function safeCanvas(canvas: BrandCanvas): BrandCanvas {
  return canvas === 'light' || canvas === 'dark' ? canvas : 'dark';
}

/**
 * The host's accent as a FILL — the colour they picked, byte for byte.
 *
 * This used to step the colour toward the canvas's pole until it cleared 3:1,
 * which is why a host's `#cbe84f` came back `#7a8b21` olive on paper. ADR 0004's
 * amendment reverses that: the host owns their brand, the engine reports the
 * contrast rather than overriding it, and an illegible pick ships illegible. The
 * accepted cost is written down in the ADR so it is not rediscovered as a bug.
 *
 * WHAT DID NOT GO AWAY, and both are load-bearing:
 *
 *  - the **invalid-hex fallback**. `apps/web/lib/embed.ts` lets a pasted embed
 *    snippet override `brand_color` from the URL; a typo there has to degrade to
 *    the DS accent, not paint the page with `undefined`. Unlike before, the
 *    fallback is returned RAW — there is no clamp left to put it through, and on
 *    the dark default canvas the lime is already 12:1.
 *  - the **`canvas` parameter**. Nothing reads it any more, and it stays anyway:
 *    every caller still has to name the ground it is painting on, `brandVars`
 *    below genuinely needs one, and a signature that quietly stopped asking
 *    would be the easiest place for preview and production to drift apart again.
 *    Kept under its real name rather than underscored — the name reaches every
 *    caller's tooltip through the emitted `.d.ts`, and `_canvas` there would
 *    read as "pass anything", which is the opposite of the discipline it exists
 *    to enforce.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function clampAccent(hex: string, canvas: BrandCanvas): string {
  return toHex(accentRgb(hex));
}

/**
 * The accent before it becomes a string. Every derivation below composes on this
 * rather than re-parsing `clampAccent`'s output: a hex round-trip between two
 * steps is what let a colour lose up to half a channel step between the check
 * that approved it and the value that shipped.
 */
function accentRgb(hex: string): Rgb {
  return parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
}

/**
 * The host's accent as LETTERS on `canvas` — `--primary-ink`.
 *
 * It used to carry AA (4.5:1) and therefore used to be a DIFFERENT colour from
 * the fill. It is not any more: the amendment applies to the accent in every one
 * of its jobs, so a host's links are the colour they chose, exactly as their
 * buttons are.
 *
 * The function stays, and emitting it stays mandatory. `globals.css` re-points
 * the `text-primary` utility at `--primary-ink` globally, so a branded surface
 * that omits the token paints the host's links in the PRODUCT's lime — the
 * repossession bug ADR 0004 was written against, which has nothing to do with
 * contrast and did not go away with the clamp.
 */
export function accentInk(hex: string, canvas: BrandCanvas): string {
  return clampAccent(hex, canvas);
}

/**
 * The host's accent as a RIM or focus outline on `canvas` — `--primary-edge`.
 *
 * globals.css rims every accent fill with this and draws the focus ring in it.
 * Kept as its own name rather than folded into `clampAccent` for the same reason
 * it always was: the rim answers to WCAG 1.4.11 about a *boundary* while the
 * fill answers about a *shape*, and if either ever grows a rule again it must be
 * able to grow one without silently moving the other.
 */
export function accentEdge(hex: string, canvas: BrandCanvas): string {
  return clampAccent(hex, canvas);
}

/**
 * The label colour that reads on top of the accent (black or white).
 *
 * THIS ONE KEEPS ITS FLOOR, and the distinction is the whole reason the ADR
 * amendment is three changes rather than one. Everything above is the host's
 * colour and theirs to get wrong. This is not their colour — it is a value the
 * engine invents to put ON their colour, and a host who picks dark green never
 * chose black text on dark green. Picking the better of the two poles is what
 * keeps a button's own label readable no matter how illegible the button is
 * against the page behind it. Measured across the whole sRGB cube the worst
 * case is 4.1:1, which is why the studio's warning can be about the CANVAS and
 * never about the label.
 */
export function onAccent(hex: string): string {
  const rgb = accentRgb(hex);
  return contrast(rgb, BLACK) >= contrast(rgb, WHITE) ? '#1a1a1c' : '#fafafa';
}

/** How legible a button's own LABEL is on the fill it sits on. `onAccent` keeps
 *  its floor, so this never drops below about 4.1:1 — it is a readout, not a
 *  warning, and the studio prints it as one. */
export function accentLabelContrast(hex: string, canvas: BrandCanvas): number {
  const accent = parseHex(clampAccent(hex, canvas))!;
  const label = parseHex(onAccent(clampAccent(hex, canvas)))!;
  return Math.round(contrast(accent, label) * 10) / 10;
}

/**
 * How legible the host's accent is against the GROUND their page paints on.
 *
 * This is the number the clamp used to act on, and now the only thing that acts
 * on it is the host. Below `MIN_ACCENT_CONTRAST` the studio shows a non-blocking
 * warning and saves anyway; nothing else in the system looks at it.
 *
 * Measured against `CANVAS_HEX`, deliberately the stricter of the page and card
 * grounds — a warning that cleared the page and then failed on a card would be
 * worse than no warning at all.
 *
 * ROUNDED DOWN, not to nearest, and that is the whole reason this is its own
 * function rather than a call to `contrastRatio`. One decimal is what a readout
 * can show, but the studio also DECIDES on this number, and rounding to nearest
 * reports a true 2.9885:1 as a passing `3` — about 4,500 colours per canvas that
 * are under the floor and would never warn. Truncating can only ever understate,
 * so the number a host reads and the number the warning fires on are one value
 * that never claims a ratio the colour does not have.
 */
export function accentCanvasContrast(hex: string, canvas: BrandCanvas): number {
  const ground = parseHex(CANVAS_HEX[safeCanvas(canvas)])!;
  return Math.floor(contrast(accentRgb(hex), ground) * 10) / 10;
}

export function accentVars(rawAccent: string, canvas: BrandCanvas): Record<string, string> {
  return accentVarsFrom(accentRgb(rawAccent), canvas);
}

/** `accentVars` given an ALREADY-parsed colour, so a caller that has one does
 *  not round-trip it through hex a second time. */
function accentVarsFrom(rgb: Rgb, canvas: BrandCanvas): Record<string, string> {
  const accent = toHex(rgb);
  return {
    '--accent': accent,
    '--accent-contrast': onAccent(accent),
    // Hover travels away from the canvas. Mixing toward white on a light canvas
    // would make the hover state FADE toward the page it sits on, i.e. the one
    // interaction that must read as "more" would read as less.
    '--accent-hover': toHex(mix(rgb, CANVAS_TARGET[safeCanvas(canvas)], 0.16)),
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
  // Parsed ONCE, and every token below derived from that one value. Deriving
  // some of them by re-parsing a string made the block able to disagree with
  // itself — `--primary` from one derivation, `--primary-edge` from a second.
  const rgb = accentRgb(rawAccent);
  const accent = toHex(rgb);
  return {
    ...accentVarsFrom(rgb, canvas),
    // Fill, letters and rim are now one colour — the host's. They stay three
    // separate keys because `globals.css` reads three separate tokens, and a
    // surface that emits only `--primary` still repossesses the other two to the
    // PRODUCT's lime. That was never a contrast problem and the amendment does
    // not touch it.
    '--primary': accent,
    '--primary-foreground': onAccent(accent),
    '--primary-ink': accent,
    '--primary-edge': accent,
    // The focus outline is drawn with `--primary-edge` (globals.css), so `--ring`
    // has to be the same colour or a focused control gets two different rims.
    '--ring': accent,
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
/**
 * The console, per ADR 0004's 2026-09-11 amendment — the product is dark and the
 * booking page is part of the product.
 *
 * The reason this is a named constant rather than a literal is that an absent
 * axis has to mean the same thing in the contract's `.default()`, in the web
 * app's resolver, and here. It is NOT the only declaration of the fact —
 * `bookingPageStyleSchema.theme` in `@slate/types` carries its own
 * `.default()` — so the two are asserted equal by a test rather than trusted to
 * stay in step. A split between them parses one canvas and paints the other.
 */
export const DEFAULT_BOOKING_THEME: BrandCanvas = 'dark';

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
    theme: DEFAULT_BOOKING_THEME,
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
