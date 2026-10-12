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
 *     depend on). The check runs AT CONNECTION TIME: the request goes out
 *     through `node:https` with a `lookup` that resolves the name, refuses the
 *     connection unless every address is public, and hands the socket exactly
 *     those addresses. A separate pre-check followed by `fetch` would resolve
 *     the name twice, and a rebinding DNS answer could pass the first and point
 *     the second inward. Redirects are never followed (`https.get` does not),
 *     so a Location header cannot move the request to an unchecked host.
 *
 * Every failure path returns null.
 */
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
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

/**
 * A socket `lookup` that resolves the host and refuses the connection unless
 * every address is public, then connects to exactly those addresses. Because
 * the check and the connection share one resolution, a DNS answer that changes
 * between them (rebinding) has nothing to change. Exported for its spec.
 */
export function pinnedLookup(resolve: OgDnsResolver): LookupFunction {
  return (hostname, options, callback) => {
    const host = hostname.replace(/^\[|\]$/g, '');
    const answer = isIP(host) ? Promise.resolve([host]) : resolve(host);
    answer.then(
      (ips) => {
        if (ips.length === 0 || !ips.every(isPublicAddress)) {
          callback(Object.assign(new Error(`refused: ${host} is not public`), { code: 'EREFUSED' }), '', 4);
          return;
        }
        const all = ips.map((address) => ({ address, family: isIP(address) }));
        if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof all) => void)(null, all);
        else callback(null, all[0]!.address, all[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    );
  };
}

/** What a transport hands back: status, type, declared length, and the body. */
export interface ImageResponse {
  status: number;
  contentType: string;
  /** The body, read up to the cap; null when it ran past it. */
  body: Buffer | null;
}
export type ImageTransport = (url: URL, lookup: LookupFunction) => Promise<ImageResponse>;

/** One GET over `node:https`, through the pinned lookup, bounded in time and size. */
const httpsTransport: ImageTransport = (url, lookup) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      // No Referer and no cookies are ever sent; `https` follows no redirects.
      { method: 'GET', lookup, timeout: FETCH_TIMEOUT_MS, headers: { accept: 'image/*' } },
      (res) => {
        const contentType = String(res.headers['content-type'] ?? '');
        if (Number(res.headers['content-length'] ?? '0') > MAX_BYTES) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, contentType, body: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.byteLength;
          if (size > MAX_BYTES) {
            res.destroy();
            resolve({ status: res.statusCode ?? 0, contentType, body: null });
          } else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });

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
  opts?: { resolve?: OgDnsResolver; transport?: ImageTransport },
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

  try {
    const transport = opts?.transport ?? httpsTransport;
    const res = await transport(url, pinnedLookup(opts?.resolve ?? defaultResolver));
    // A redirect is a 3xx here, never followed: it is simply not an image.
    if (res.status < 200 || res.status >= 300 || !res.body) return null;
    const type = res.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!DECODABLE.has(type)) return null;
    return `data:${type};base64,${res.body.toString('base64')}`;
  } catch {
    // Refused address, timeout, DNS, TLS, an aborted body: all the same answer.
    return null;
  }
}
