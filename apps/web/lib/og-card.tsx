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
 * The part of the card every app shows. Slack draws a link's image as a square
 * cut from its middle (verified 2026-11-24: Slack stores this card as a full
 * 1200x630 `image_url`, exactly as it stores cal.com's and vercel.com's, and
 * its client still paints a centred square of it beside the text), and
 * WhatsApp does the same in its compact preview. So everything that says who,
 * what and how long sits on a panel inside this square; only the product mark,
 * which nobody needs to read, lives outside it.
 */
export const OG_SAFE_SQUARE = {
  left: (OG_SIZE.width - OG_SIZE.height) / 2,
  size: OG_SIZE.height,
} as const;

/** The panel's distance from the safe square's edges, so a crop never lands on its border. */
const PANEL_INSET = 24;
export const OG_PANEL = {
  left: OG_SAFE_SQUARE.left + PANEL_INSET,
  top: PANEL_INSET,
  width: OG_SAFE_SQUARE.size - PANEL_INSET * 2,
  height: OG_SIZE.height - PANEL_INSET * 2,
} as const;

/**
 * Satori draws from values, not from a stylesheet, so the booking ground's few
 * colours are restated here. They are the `.bp-ground[data-theme=...]` values in
 * `@slate/shared/tokens.css`, frozen there for every live booking page, and
 * `og-card.spec.ts` reads that file and fails the moment the two disagree.
 */
export const OG_GROUND: Record<
  BrandCanvas,
  { background: string; card: string; foreground: string; muted: string; border: string }
> = {
  light: {
    background: '#f4f6f8',
    card: '#ffffff',
    foreground: '#0d1013',
    muted: '#55636f',
    border: 'rgba(20, 32, 44, 0.22)',
  },
  dark: {
    background: '#0a0c0e',
    card: '#101418',
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
  /** The photo is a logo (a team's): drawn whole, never cut to a circle. */
  photoIsLogo?: boolean;
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
  const avatarSize = c.kind === 'profile' ? 120 : 64;
  // The page's monogram, restated: the accent as ink, pulled a third toward the
  // text colour, on a 16% tint of itself; shaped by the Corners setting.
  const monogramInk = mixHex(accent, ground.foreground, 0.66);
  const monogramGround = mixHex(accent, ground.background, 0.16);
  const avatarRadius =
    c.photo && !c.photoIsLogo ? avatarSize / 2 : px(vars['--bp-avatar-radius'], avatarSize);
  // The page's 44px button, scaled to the card's 56px one; a pill stays a pill.
  const buttonRadius = Math.min(px(vars['--bp-btn-radius'], 56) * 1.3, 28);
  // The panel is the booking page's own card, its corners scaled the same way.
  const panelRadius = Math.min(px(vars['--bp-radius'], 40) * 2.4, 40);
  // The accent, barely there, so the ground either side of the panel is not a void.
  const glow = mixHex(accent, ground.background, c.canvas === 'dark' ? 0.16 : 0.22);

  const avatar = c.photo ? (
    <img
      src={c.photo}
      width={avatarSize}
      height={avatarSize}
      style={{ borderRadius: avatarRadius, objectFit: c.photoIsLogo ? 'contain' : 'cover' }}
      alt=""
    />
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

  const markHeight = 24;
  // Long host text gets a smaller size before it gets clipped: the square is
  // narrow, and a title that fits whole is worth more than a large one cut short.
  const title = clip(c.title, 64);
  const titleSize = title.length <= 22 ? 60 : title.length <= 40 ? 50 : 42;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        position: 'relative',
        background: ground.background,
        // Fades to the ground itself at zero alpha: Satori reads `transparent` as
        // transparent black, which greys a light canvas on the way out.
        backgroundImage: `radial-gradient(circle at 8% 12%, ${glow} 0%, ${ground.background}00 38%), radial-gradient(circle at 92% 90%, ${glow} 0%, ${ground.background}00 38%)`,
        color: ground.foreground,
        fontFamily: 'Card',
      }}
    >
      {/* The product, small, in a corner every crop may drop. */}
      {c.productName ? (
        <div
          style={{
            position: 'absolute',
            top: 48,
            right: 56,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 22,
            color: ground.muted,
          }}
        >
          <img src={productMark(ground.foreground)} width={Math.round(markHeight * MARK_RATIO)} height={markHeight} alt="" />
          {c.productName}
        </div>
      ) : null}

      {/* The panel: everything that matters, inside the square every app keeps. */}
      <div
        style={{
          position: 'absolute',
          left: OG_PANEL.left,
          top: OG_PANEL.top,
          width: OG_PANEL.width,
          height: OG_PANEL.height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '44px 40px 40px',
          background: ground.card,
          border: `1.5px solid ${ground.border}`,
          borderRadius: panelRadius,
        }}
      >
        {/* Who. */}
        {c.kind === 'event' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, maxWidth: '100%' }}>
            {avatar}
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, wordBreak: 'break-word' }}>{clip(c.hostName, 26)}</div>
          </div>
        ) : (
          avatar
        )}

        {/* What. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              textAlign: 'center',
              width: '100%',
              fontSize: titleSize,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: -1,
              // Host text may hold a word longer than the panel (a pasted URL);
              // it wraps inside the square rather than running out of it.
              wordBreak: 'break-word',
            }}
          >
            {title}
          </div>
          {c.subtitle ? (
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                textAlign: 'center',
                width: '100%',
                fontSize: 24,
                lineHeight: 1.35,
                color: ground.muted,
                wordBreak: 'break-word',
              }}
            >
              {clip(c.subtitle, 80)}
            </div>
          ) : null}
        </div>

        {/* How long, and the page's own primary. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {c.duration ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 20px',
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
          ) : null}
          <div
            style={{
              display: 'flex',
              padding: '14px 28px',
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
    </div>
  );
}

/**
 * How long a rendered card may be reused: a hint to whatever sits in front of
 * the route and to crawlers. Ten minutes is set by the one thing it can get
 * wrong: a host who changes their colour and re-shares expects the new card.
 */
const CACHE_CONTROL = 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400';
/**
 * Never reused: a card whose language came from the request's own headers (an
 * address without `?lang=`), which a shared cache keyed on the URL alone would
 * hand to the next reader in the wrong language, and the empty card, which is
 * also what a brief API failure draws and must not be pinned at an edge. The
 * `.png` address makes both likelier to meet a cache that keys on the
 * extension.
 */
const NO_STORE = 'no-store';

export function bookingCardResponse(c: BookingCardInput, opts: { reusable?: boolean } = {}): ImageResponse {
  return new ImageResponse(<BookingCard {...c} />, {
    ...OG_SIZE,
    fonts: cardFonts(),
    headers: { 'cache-control': opts.reusable === false ? NO_STORE : CACHE_CONTROL },
  });
}

/** The card for a link that resolves to nothing: the ground, and no claims. */
export function emptyCardResponse(canvas: BrandCanvas = 'light'): ImageResponse {
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', background: OG_GROUND[canvas].background }} />, {
    ...OG_SIZE,
    headers: { 'cache-control': NO_STORE },
  });
}
