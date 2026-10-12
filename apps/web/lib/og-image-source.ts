/**
 * The host's photo, made drawable for the link preview.
 *
 * The page never needs this: it emits an `<img src>` and the visitor's browser
 * fetches. A rasterized card has no browser, so the server fetches instead, and
 * three things can go wrong, none of which may take the card down:
 *
 *  1. Format. Satori decodes PNG, JPEG, GIF and SVG. It cannot decode WebP,
 *     which is what the studio's upload produces on most browsers
 *     (`lib/image-file.ts`) and what many CDNs serve. An undecodable image is
 *     DROPPED (the card draws the monogram) rather than passed on to throw
 *     mid-render.
 *  2. Time. A slow origin would hold a social crawler until it gives up and
 *     shows no card at all, which is worse than a card with a monogram.
 *  3. Reach. The URL is host-supplied (a pasted URL) or synced from a calendar
 *     provider, and the server now resolves it from inside the deployment, so
 *     it is a request-forgery surface the `<img>` never was. Only https; the
 *     hostname is checked, then RESOLVED, and any loopback, private,
 *     link-local or unique-local address is refused (the same classes as the
 *     webhook guard in `@slate/db`, `webhook-url.ts`, which this app does not
 *     depend on). Redirects are refused outright: following one would land on
 *     a hostname none of these checks saw.
 *
 * Every failure path returns null.
 */
import { isIP } from 'node:net';

/** Satori's decoders. WebP and AVIF are absent because it has none. */
const DECODABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

const FETCH_TIMEOUT_MS = 2_500;
const MAX_BYTES = 1_500_000;

const BLOCKED_HOST = [/^localhost$/i, /\.localhost$/i, /\.internal$/i, /\.local$/i, /^metadata$/i];

/** Resolve a hostname to its addresses (A and AAAA). Injectable for tests. */
export type OgDnsResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: OgDnsResolver = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

/** True for a public unicast address only. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = o as [number, number, number, number];
    if (a === 127 || a === 10 || a === 0) return false; // loopback, private, "this host"
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped, in both spellings: dotted from DNS answers, and the hex pair
    // the URL parser canonicalizes a hostname to.
    const dotted = lower.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) return isPublicAddress(dotted[1]!);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === '::1' || lower === '::') return false; // loopback, unspecified
    if (/^fe[89ab]/.test(lower)) return false; // fe80::/10 link-local
    const firstByte = parseInt(lower.split(':')[0]?.padStart(4, '0').slice(0, 2) || '0', 16);
    if ((firstByte & 0xfe) === 0xfc) return false; // fc00::/7 unique-local
    return true;
  }
  return false;
}

async function reachesOnlyPublicAddresses(url: URL, resolve: OgDnsResolver): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPublicAddress(host);
  try {
    const ips = await resolve(host);
    return ips.length > 0 && ips.every(isPublicAddress);
  } catch {
    return false;
  }
}

/** An inline `data:` image the card can draw as is: a decodable type, bounded. */
function inlineImage(raw: string): string | null {
  const type = raw.slice(5, raw.indexOf(';')).toLowerCase();
  if (!DECODABLE.has(type) || !/^data:[^;,]+;base64,/i.test(raw)) return null;
  return raw.length <= Math.ceil((MAX_BYTES * 4) / 3) + 64 ? raw : null;
}

/**
 * The photo as a `data:` URI Satori can draw, or null when it cannot be used.
 * A data URI rather than the original URL on purpose: Satori would otherwise
 * fetch it a second time itself, with none of the guards above.
 */
export async function cardImageDataUri(
  raw: string | null | undefined,
  opts?: { resolve?: OgDnsResolver },
): Promise<string | null> {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (/^data:/i.test(trimmed)) return inlineImage(trimmed);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (BLOCKED_HOST.some((re) => re.test(url.hostname))) return null;
  if (!(await reachesOnlyPublicAddresses(url, opts?.resolve ?? defaultResolver))) return null;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      // The photo belongs to someone else's CDN; never send it the card's URL.
      referrerPolicy: 'no-referrer',
      cache: 'force-cache',
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!DECODABLE.has(type)) return null;
    // Content-Length is a hint, not a promise, so the body is measured too.
    if (Number(res.headers.get('content-length') ?? '0') > MAX_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) return null;
    return `data:${type};base64,${buffer.toString('base64')}`;
  } catch {
    // Timeout, DNS, TLS, an aborted body: all the same answer.
    return null;
  }
}
