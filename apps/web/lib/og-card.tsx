import { readFileSync } from 'node:fs';
import { ImageResponse } from 'next/og';
import {
  brandVars,
  initials,
  widgetStyleVars,
  type BookingButtons,
  type BookingCorners,
  type BrandCanvas,
} from '@slate/shared';
import { cardFonts } from '@/lib/og-fonts';

/**
 * The booking page's link preview: what a host's link unfurls as in a chat, an
 * email or a social post, which for most invitees is the first look at the page.
 *
 * It is drawn from the host's OWN page: the canvas, the accent, the Buttons and
 * Corners settings, the photo or the monogram, the name, and for an event its
 * title and length. So the card and the page it opens read as one thing, and a
 * colour changed in the studio restyles the card with nothing to upload.
 *
 * The product is named small, and only on a Dapta build (`IS_DAPTA_BRAND`): a
 * fork's card carries the host and nothing else, the same open-core rule as the
 * "Made with" badge. Like the badge, an account that turned the Dapta branding
 * off while paying gets no product name either (the routes pass null).
 */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/**
 * Satori draws from values, not from a stylesheet, so the booking ground's few
 * colours are restated here. They are the `.bp-ground[data-theme=...]` values in
 * `@slate/shared/tokens.css`, frozen there for every live booking page, and
 * `og-card.spec.ts` reads that file and fails the moment the two disagree.
 */
export const OG_GROUND: Record<
  BrandCanvas,
  { background: string; foreground: string; muted: string; border: string }
> = {
  light: {
    background: '#f4f6f8',
    foreground: '#0d1013',
    muted: '#55636f',
    border: 'rgba(20, 32, 44, 0.22)',
  },
  dark: {
    background: '#0a0c0e',
    foreground: '#e8edf2',
    muted: '#93a1ae',
    border: 'rgba(148, 170, 190, 0.16)',
  },
};

/**
 * Truncate on a word boundary. A cut mid-word is the loudest tell that an image
 * was generated rather than designed, and titles here are host text of any
 * length. Falls back to the hard cut only when the last space is so early that
 * breaking on it would throw most of the line away.
 */
export function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[,;:.\s]+$/, '')}…`;
}

type Rgb = [number, number, number];

function rgbOf(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

/** `color-mix(in srgb, a share%, b)`, which Satori does not parse. */
export function mixHex(a: string, b: string, share: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return `#${x
    .map((v, i) => Math.round(v * share + y[i]! * (1 - share)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** A radius token (`8px`, `999px`, `30%`) as pixels on a box of `size`. */
function px(token: string | undefined, size: number): number {
  if (!token) return 0;
  if (token.endsWith('%')) return (parseFloat(token) / 100) * size;
  return parseFloat(token);
}

/**
 * The dC mark as an SVG image, its ink in `color`. Read from a file the React
 * mark is pinned to (`og-mark.spec.tsx`): a route cannot render a component to
 * a string. A literal `new URL` so the file is traced into the standalone build.
 */
const MARK_FILE = new URL('../assets/brand/dc-mark.svg', import.meta.url);
let markSvg: string | null = null;
function productMark(color: string): string {
  markSvg ??= readFileSync(MARK_FILE, 'utf8');
  // The ink is `currentColor` in the product; an image has no current colour.
  const svg = markSvg.split('currentColor').join(color);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
/** The mark's intrinsic proportions, from its `viewBox`. */
const MARK_RATIO = 1141.464 / 715.8;

export interface BookingCardInput {
  canvas: BrandCanvas;
  accent: string;
  buttons?: BookingButtons;
  corners?: BookingCorners;
  hostName: string;
  /** A drawable photo (`og-image-source.ts`), or null for the monogram. */
  photo: string | null;
  /** The headline: the event's title, or on a profile the host's name. */
  title: string;
  /** A supporting line (the event's description or the host's bio). */
  subtitle?: string | null;
  /** The event's length, already worded ("30 min"); absent on a profile. */
  duration?: string | null;
  /** The button's words ("Book a time"). */
  cta: string;
  /** Whether the host's name sits in the top rail (an event) or is the title. */
  kind: 'event' | 'profile';
  /** Name the product small; only a Dapta build passes a name. */
  productName: string | null;
}

/** The card, as the element tree `ImageResponse` draws. Exported for the spec. */
export function BookingCard(c: BookingCardInput) {
  const ground = OG_GROUND[c.canvas];
  const vars = { ...brandVars(c.accent, c.canvas), ...widgetStyleVars({ buttons: c.buttons, corners: c.corners }) };
  const accent = vars['--accent']!;
  const onAccent = vars['--accent-contrast']!;
  const avatarSize = c.kind === 'profile' ? 132 : 88;
  // The page's monogram, restated: the accent as ink, pulled a third toward the
  // text colour, on a 16% tint of itself; shaped by the Corners setting.
  const monogramInk = mixHex(accent, ground.foreground, 0.66);
  const monogramGround = mixHex(accent, ground.background, 0.16);
  const avatarRadius = c.photo ? avatarSize / 2 : px(vars['--bp-avatar-radius'], avatarSize);
  // The page's 44px button, scaled to the card's 64px one; a pill stays a pill.
  const buttonRadius = Math.min(px(vars['--bp-btn-radius'], 64) * 1.45, 32);

  const avatar = c.photo ? (
    <img src={c.photo} width={avatarSize} height={avatarSize} style={{ borderRadius: avatarRadius, objectFit: 'cover' }} alt="" />
  ) : (
    <div
      style={{
        display: 'flex',
        width: avatarSize,
        height: avatarSize,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: avatarRadius,
        background: monogramGround,
        color: monogramInk,
        fontSize: Math.round(avatarSize * 0.36),
        fontWeight: 700,
        letterSpacing: 1,
      }}
    >
      {initials(c.hostName)}
    </div>
  );

  const markHeight = 26;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: ground.background,
        color: ground.foreground,
        fontFamily: 'Card',
      }}
    >
      {/* Rail: who. The host on the left; the product, small, opposite. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          {avatar}
          {c.kind === 'event' ? (
            <div style={{ display: 'flex', fontSize: 32, fontWeight: 700 }}>{clip(c.hostName, 40)}</div>
          ) : null}
        </div>
        {c.productName ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 22, color: ground.muted }}>
            <img src={productMark(ground.foreground)} width={Math.round(markHeight * MARK_RATIO)} height={markHeight} alt="" />
            {c.productName}
          </div>
        ) : null}
      </div>

      {/* Body: what. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, lineHeight: 1.06, letterSpacing: -1.5 }}>
          {clip(c.title, 64)}
        </div>
        {c.subtitle ? (
          <div style={{ display: 'flex', fontSize: 28, lineHeight: 1.35, color: ground.muted }}>
            {clip(c.subtitle, 120)}
          </div>
        ) : null}
      </div>

      {/* Base: how long, and the page's own primary. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {c.duration ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 20px',
              border: `1.5px solid ${ground.border}`,
              borderRadius: buttonRadius,
              fontSize: 24,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ground.muted} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            {c.duration}
          </div>
        ) : (
          <div style={{ display: 'flex' }} />
        )}
        <div
          style={{
            display: 'flex',
            padding: '16px 32px',
            borderRadius: buttonRadius,
            background: accent,
            color: onAccent,
            fontSize: 24,
            fontWeight: 700,
          }}
        >
          {c.cta}
        </div>
      </div>
    </div>
  );
}

/**
 * How long a rendered card may be reused: a hint to whatever sits in front of
 * the route and to crawlers. Ten minutes is set by the one thing it can get
 * wrong: a host who changes their colour and re-shares expects the new card.
 */
const CACHE_CONTROL = 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400';

export function bookingCardResponse(c: BookingCardInput): ImageResponse {
  return new ImageResponse(<BookingCard {...c} />, {
    ...OG_SIZE,
    fonts: cardFonts(),
    headers: { 'cache-control': CACHE_CONTROL },
  });
}

/** The card for a link that resolves to nothing: the ground, and no claims. */
export function emptyCardResponse(canvas: BrandCanvas = 'light'): ImageResponse {
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', background: OG_GROUND[canvas].background }} />, {
    ...OG_SIZE,
    headers: { 'cache-control': CACHE_CONTROL },
  });
}
