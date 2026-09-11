import { bookingPageStyleSchema } from '@slate/types';

/**
 * Inline embed mode (E) — the one place that decides what `?embed=1` means.
 *
 * All four public booking routes read this, so the mode has ONE definition
 * rather than four that can drift. Pure: no `next/headers`, no React, no DOM —
 * which is what lets the route (server), the snippet builder (admin client) and
 * the spec suite all import the same function.
 */

/** The query keys the embed understands, in the order the snippet writes them. */
export const EMBED_PARAM = 'embed';

/**
 * The class the routes hang on `BrandedShell` in embed mode.
 *
 * It is both the CSS hook (globals.css `.branded-surface.dc-embed …`) and the
 * element the height reporter MEASURES, which is why it is a shared constant
 * rather than a literal in three files: if the two ever named different
 * elements, the frame would size itself against something it is not styling.
 */
export const EMBED_ROOT_CLASS = 'dc-embed';

/**
 * The ten appearance axes of `bookingPageStyleSchema`, as the loose snake_case
 * names a snippet carries, mapped to the camelCase keys the style object uses.
 *
 * Ten, not thirteen: `landingEnabled`, `defaultEventSlug` and `bio` live in the
 * same schema but change BEHAVIOUR and CONTENT, not appearance, and a third
 * party who can restyle an embed must not also be able to redirect it or
 * rewrite the host's bio (#67).
 *
 * `theme` is the tenth (B2, #109) and it is the one axis that changes the
 * page's GROUND rather than a shape on it, which is exactly why an embed gets
 * to set it: a host pasting a booking page into their own dark site needs it to
 * stop being a sheet of paper in the middle of their layout.
 */
export const EMBED_STYLE_PARAMS = {
  template: 'template',
  card_style: 'cardStyle',
  corners: 'corners',
  buttons: 'buttons',
  density: 'density',
  font: 'font',
  slot_layout: 'slotLayout',
  day_group: 'dayGroup',
  slot_select: 'slotSelect',
  theme: 'theme',
} as const;

export type EmbedStyleParam = keyof typeof EMBED_STYLE_PARAMS;

/** The accent's own param — not an axis, so it is named separately. */
export const EMBED_ACCENT_PARAM = 'brand_color';

/** What a route needs to know about the request it is rendering. */
export interface EmbedMode {
  /** True when this render is inside a host page's iframe. */
  embed: boolean;
  /**
   * Appearance overrides from the URL, already validated. Empty unless `embed`
   * is true.
   *
   * The gate is the PARAMETER, not "is this in a frame" — a server cannot tell.
   * So `…?embed=1&brand_color=cc0000` opened directly in a tab is a restyled
   * booking page on the real domain, and that is accepted: the booking still
   * lands on the real host's calendar, the overrides are appearance-only, and
   * the page is `noindex` under embed. What the gate buys is that a link
   * WITHOUT the parameter — the one a host actually shares — cannot be
   * restyled by whoever passes it on (#67).
   */
  brandColor: string | null;
  style: Record<string, string>;
}

/** The loose shape Next hands a page as `searchParams`. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * A raw query string back into the shape a page receives as `searchParams`.
 *
 * The routes are handed `searchParams` and read the mode straight off it. The
 * two places that are NOT a route — the root layout (which sees the query as a
 * middleware header) and `ThemeStamp` (which sees `location.search`) — have to
 * answer the same question about the same request, and they do it by rebuilding
 * this shape and calling `parseEmbedParams`. One parser, three callers, rather
 * than a second reading of the contract that can drift from the first.
 *
 * Repeats are kept in order rather than collapsed, because `parseEmbedParams`
 * is the thing that decides first-value-wins.
 */
export function searchParamsFromQuery(query: string | null | undefined): RawSearchParams {
  const out: RawSearchParams = {};
  if (!query) return out;
  for (const [key, value] of new URLSearchParams(query)) {
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}

/** First value wins when a key repeats — a snippet never writes two. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `embed=1` turns the mode on; `embed=true` is accepted because a host
 * hand-editing a snippet writes it about as often. Anything else — including
 * `embed=0` and a bare `?embed` — is not embed mode: the failure direction
 * that matters is a page accidentally rendering AS an embed, not one failing to.
 */
export function isEmbedRequest(params: RawSearchParams | undefined): boolean {
  const raw = one(params?.[EMBED_PARAM])?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * A six-hex accent, with or without its `#`.
 *
 * `#` is a URL's fragment delimiter, so a host who hand-edits a snippet will
 * write `brand_color=1a73e8` at least as often as `brand_color=%231a73e8`. A
 * missing hash is normalised rather than rejected; anything that is not six hex
 * digits is dropped. The value then passes through the same `clampAccent` every
 * stored accent does (in `BrandedShell`), so an illegible colour self-corrects
 * instead of painting invisible text.
 */
export function parseAccentParam(raw: string | undefined): string | null {
  if (!raw) return null;
  const hex = raw.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

/**
 * Read the embed mode and its appearance overrides off a request's query.
 *
 * Each axis is validated ON ITS OWN against the schema's existing enum, and an
 * invalid value is DROPPED rather than raised. One typo in a snippet costs that
 * one axis; it never costs the others and it never returns an error, because a
 * snippet pasted by a third party must not be able to take a host's booking
 * page down (#67).
 */
export function parseEmbedParams(params: RawSearchParams | undefined): EmbedMode {
  const embed = isEmbedRequest(params);
  if (!embed || !params) return { embed, brandColor: null, style: {} };

  const shape = bookingPageStyleSchema.shape;
  const style: Record<string, string> = {};
  for (const [param, key] of Object.entries(EMBED_STYLE_PARAMS) as [
    EmbedStyleParam,
    keyof typeof shape,
  ][]) {
    const raw = one(params[param]);
    if (raw === undefined) continue;
    // Validated against the CONTRACT's own enum rather than a copy of it, so a
    // value the schema stopped accepting stops being accepted here on the same
    // day. A failure drops this axis and leaves every other one standing.
    const parsed = shape[key].safeParse(raw.trim());
    if (parsed.success && typeof parsed.data === 'string') style[key] = parsed.data;
  }

  return { embed, brandColor: parseAccentParam(one(params[EMBED_ACCENT_PARAM])), style };
}

/**
 * Merge URL overrides over the style the server holds.
 *
 * Server value is the floor: an embed with no params looks exactly like the
 * host's booking page, which is what "use my booking page style" means in the
 * snippet dialog.
 */
export function mergeEmbedStyle(
  serverStyle: Record<string, unknown> | null,
  overrides: Record<string, string>,
): Record<string, unknown> | null {
  if (Object.keys(overrides).length === 0) return serverStyle;
  return { ...(serverStyle ?? {}), ...overrides };
}

/**
 * Carry the query string through a redirect.
 *
 * Both public 308s (canonical account code) and the R25 landing redirect
 * rebuild their target by hand. Without this an alias-code URL in a pasted
 * snippet 308s to a FULL-CHROME page inside the frame, and the embed silently
 * stops being an embed.
 */
export function withSearchParams(path: string, params: RawSearchParams | undefined): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The URL an iframe points at: the public path, in embed mode, with the accent
 * when the host picked one. Written as a path so the caller can resolve it
 * against the real origin (the admin only knows it client-side).
 */
export function embedSrcPath(publicPath: string, brandColor?: string | null): string {
  const accent = parseAccentParam(brandColor ?? undefined);
  const qs = new URLSearchParams({ [EMBED_PARAM]: '1' });
  if (accent) qs.set(EMBED_ACCENT_PARAM, accent);
  return `${encodePath(publicPath)}?${qs.toString()}`;
}

/**
 * Percent-encode each segment of a public path.
 *
 * The path is not always server-derived: the studio builds it live from the
 * handle and vanity fields as they are typed, and those are raw input until the
 * save round-trip. A space or a quote in there produced a snippet with a broken
 * or unusable `src`. Segments are encoded individually so the separators
 * survive. Callers pass RAW segments — an already-encoded path would be encoded
 * twice, and nothing in this app has one.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/');
}

/**
 * Escape a value for an HTML double-quoted attribute.
 *
 * The snippet is text a host pastes into their own page, so it has to be valid
 * there — this is not an XSS boundary in the admin (React escapes the textarea
 * that displays it), it is the difference between a snippet that works and one
 * that silently breaks out of an attribute on somebody else's site. `&` matters
 * as much as `"`: an accent override puts a bare `&` in the `src`, and a title
 * like `Sales & Marketing` puts one in the `title`.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The copy-paste snippet.
 *
 * Declarative iframe FIRST, script second — the shape is the whole reason this
 * one was chosen over a `<div data-url>` that a script hydrates: with JS
 * blocked the iframe still renders and still takes bookings, losing only
 * auto-resize. `min-height` is the pre-JS floor, and it is 700px because the
 * three-region layout with a month grid in it is taller than a lead form.
 */
export function embedSnippet({
  origin,
  publicPath,
  brandColor,
  title,
}: {
  origin: string;
  publicPath: string;
  brandColor?: string | null;
  title: string;
}): string {
  const src = escapeAttr(`${origin}${embedSrcPath(publicPath, brandColor)}`);
  return [
    `<iframe data-dapta-calendars src="${src}"`,
    `        title="${escapeAttr(title)}" loading="lazy"`,
    `        style="width:100%;border:0;min-height:700px;"></iframe>`,
    `<script src="${escapeAttr(origin)}/embed.js" async></script>`,
  ].join('\n');
}
