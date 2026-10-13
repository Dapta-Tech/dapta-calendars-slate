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
 *     the second inward. A literal address never reaches a `lookup` (the
 *     socket connects to it directly), so it is classified before the request
 *     instead. Redirects are never followed (`https.get` does not), so a
 *     Location header cannot move the request to an unchecked host.
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
    const [a, b, c] = o as [number, number, number, number];
    if (a === 127 || a === 10 || a === 0) return false; // loopback, private, "this host"
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0.0/24 protocol, 192.0.2.0/24 documentation
    if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
    if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false; // documentation
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    const v4 = (hi: number, lo: number) => isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    // An address that carries an IPv4 one is judged by it, in every spelling
    // (dotted from a DNS answer, the hex pair the URL parser canonicalizes a
    // hostname to): a socket can reach that IPv4 host through each of these.
    if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!); // ::ffff:0:0/96, IPv4-mapped
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!); // ::ffff:0:0:0/96, translated
    if (zero(0, 6)) return v4(g[6]!, g[7]!); // ::/96, IPv4-compatible (also :: and ::1)
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!); // 64:ff9b::/96, NAT64
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48, local NAT64
    if (g[0] === 0x2002) return v4(g[1]!, g[2]!); // 2002::/16, 6to4
    if (g[0] === 0x2001 && g[1] === 0) return false; // 2001::/32, Teredo (tunnels to an IPv4 host)
    if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // 2001:db8::/32, documentation
    if (g[0] === 0x100 && zero(1, 4)) return false; // 100::/64, discard-only
    if ((g[0]! & 0xff00) === 0xff00) return false; // ff00::/8, multicast
    if ((g[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10, link-local
    if ((g[0]! & 0xffc0) === 0xfec0) return false; // fec0::/10, site-local (deprecated)
    if ((g[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7, unique-local
    return true;
  }
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address, whatever its spelling: `::`
 * expanded, a dotted IPv4 tail folded into the last two groups, a zone id
 * dropped. Null for anything that is not one.
 */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parts = (part: string) => (part ? part.split(':') : []);
  const head = parts(halves[0]!);
  const tail = halves.length === 2 ? parts(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((x) =>
    /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : Number.NaN,
  );
  return groups.every((x) => !Number.isNaN(x)) ? groups : null;
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
  // A literal address is checked HERE or not at all: a socket handed an IP
  // never calls `lookup`, so the pinned lookup below never sees it. The URL
  // parser has already canonicalized it (`https://2130706433/` is 127.0.0.1,
  // `[::ffff:127.0.0.1]` is `[::ffff:7f00:1]`); an IPv6 host keeps its brackets.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !isPublicAddress(literal)) return null;

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
