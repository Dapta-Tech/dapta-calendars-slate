import { describe, expect, it, vi } from 'vitest';
import { cardImageDataUri, isPublicAddress, pinnedLookup, type ImageTransport } from './og-image-source';

/**
 * The link preview's photo fetch is about REFUSAL: every URL it will not
 * resolve and every byte Satori cannot draw comes back as null, because the
 * alternative is a throw inside `ImageResponse` and a link with no card.
 * DNS is injected: a unit test must not depend on the machine's resolver.
 */
const publicDns = { resolve: async () => ['93.184.216.34'] };

const respond =
  (contentType: string, body: Buffer | null = Buffer.from([1, 2, 3]), status = 200): ImageTransport =>
  async () => ({ status, contentType, body });

/** Run a lookup the way a socket would and report what it was handed. */
function lookupOnce(resolve: (h: string) => Promise<string[]>, host: string, all = false) {
  return new Promise<{ err: Error | null; address: unknown }>((done) => {
    pinnedLookup(resolve)(host, { all } as never, ((err: Error | null, address: unknown) =>
      done({ err, address })) as never);
  });
}

describe('cardImageDataUri: what it draws', () => {
  it('returns the bytes inline, so Satori never fetches past the guards', async () => {
    await expect(
      cardImageDataUri('https://cdn.example.test/a.jpg', { ...publicDns, transport: respond('image/jpeg') }),
    ).resolves.toBe(`data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  });
  it('hands the transport the pinned lookup, so the connection is checked, not a separate pre-check', async () => {
    const transport = vi.fn<ImageTransport>(respond('image/png'));
    await cardImageDataUri('https://cdn.example.test/a.png', { ...publicDns, transport });
    expect(transport).toHaveBeenCalledWith(expect.any(URL), expect.any(Function));
  });
  it('passes an uploaded PNG or JPEG data URL through without a request', async () => {
    const transport = vi.fn<ImageTransport>();
    await expect(cardImageDataUri('data:image/png;base64,AAAA', { transport })).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('cardImageDataUri: what it refuses', () => {
  it('drops WebP, inline or fetched (the monogram draws instead)', async () => {
    await expect(cardImageDataUri('data:image/webp;base64,AAAA')).resolves.toBeNull();
    await expect(
      cardImageDataUri('https://cdn.example.test/a.webp', { ...publicDns, transport: respond('image/webp') }),
    ).resolves.toBeNull();
  });
  it('drops http and blocked names before any request', async () => {
    const transport = vi.fn<ImageTransport>();
    await expect(cardImageDataUri('http://cdn.example.test/a.png', { ...publicDns, transport })).resolves.toBeNull();
    await expect(cardImageDataUri('https://localhost/a.png', { ...publicDns, transport })).resolves.toBeNull();
    await expect(cardImageDataUri('https://box.internal/a.png', { ...publicDns, transport })).resolves.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
  it('drops a redirect, a non-OK response, an oversized body and a failed request', async () => {
    const at = (t: ImageTransport) => cardImageDataUri('https://cdn.example.test/a.png', { ...publicDns, transport: t });
    await expect(at(respond('image/png', Buffer.from([1]), 302))).resolves.toBeNull();
    await expect(at(respond('image/png', Buffer.from([1]), 404))).resolves.toBeNull();
    await expect(at(respond('image/png', null))).resolves.toBeNull();
    await expect(at(async () => Promise.reject(new Error('timeout')))).resolves.toBeNull();
  });
  it('drops nothing at all', async () => {
    await expect(cardImageDataUri(null)).resolves.toBeNull();
    await expect(cardImageDataUri('   ')).resolves.toBeNull();
  });
});

describe('the connection itself is pinned (DNS rebinding)', () => {
  it('refuses a name that resolves inward, a mixed answer, no answer, and an inward literal', async () => {
    expect((await lookupOnce(async () => ['10.0.0.5'], 'inward.example.test')).err).toBeTruthy();
    expect((await lookupOnce(async () => ['93.184.216.34', '169.254.169.254'], 'mixed.example.test')).err).toBeTruthy();
    expect((await lookupOnce(async () => [], 'empty.example.test')).err).toBeTruthy();
    expect((await lookupOnce(async () => ['93.184.216.34'], '[::ffff:a00:5]')).err).toBeTruthy();
  });

  it('connects to exactly the addresses it checked, resolving once per connection', async () => {
    const resolve = vi.fn(async () => ['93.184.216.34']);
    expect(await lookupOnce(resolve, 'cdn.example.test')).toEqual({ err: null, address: '93.184.216.34' });
    expect((await lookupOnce(resolve, 'cdn.example.test', true)).address).toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('a name that answers inward at connection time gets no request, through the real https path', async () => {
    // The rebinding shape: there is no pre-check to fool. The only resolution
    // is the connection's own, it says inward, and the lookup refuses before
    // any socket opens, so nothing leaves the machine.
    const answers = [['127.0.0.1']];
    const resolve = vi.fn(async () => answers.shift() ?? ['93.184.216.34']);
    await expect(cardImageDataUri('https://rebind.example.test/a.png', { resolve })).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('a literal address in the URL (no lookup ever runs for it)', () => {
  // A socket handed an IP connects to it without calling `lookup`, so the
  // pinned lookup cannot refuse these: the literal is classified before the
  // transport is called, or the card requests a private service.
  const inward = [
    'https://127.0.0.1:8443/a.png',
    'https://2130706433/a.png', // 127.0.0.1, as the URL parser reads it
    'https://10.0.0.5/a.png',
    'https://10.255.255.255/a.png',
    'https://169.254.169.254/latest/meta-data/a.png',
    'https://192.168.1.1/a.png',
    'https://[::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png',
    'https://[::ffff:10.0.0.5]/a.png',
    'https://[::ffff:169.254.169.254]/a.png',
    'https://[fe80::1]/a.png',
    'https://[fd00::5]/a.png',
    'https://[64:ff9b::a00:5]/a.png', // NAT64 for 10.0.0.5
    'https://[::7f00:1]/a.png', // IPv4-compatible 127.0.0.1
  ];
  for (const raw of inward) {
    it(`refuses ${raw} before any request`, async () => {
      const transport = vi.fn<ImageTransport>(respond('image/png'));
      await expect(cardImageDataUri(raw, { ...publicDns, transport })).resolves.toBeNull();
      expect(transport).not.toHaveBeenCalled();
    });
  }

  it('still draws from a public literal, IPv4 or IPv6', async () => {
    for (const raw of ['https://93.184.216.34/a.png', 'https://[2606:2800:220:1::1]/a.png']) {
      const transport = vi.fn<ImageTransport>(respond('image/png'));
      await expect(cardImageDataUri(raw, { ...publicDns, transport }), raw).resolves.toMatch(/^data:image\/png;base64,/);
      expect(transport, raw).toHaveBeenCalledTimes(1);
    }
  });
});

describe('isPublicAddress', () => {
  it('classifies the ranges a card must never reach', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '2606:2800:220:1::1']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('judges an IPv6 address that carries an IPv4 one by that IPv4 address, in every spelling', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:a00:5',
      '::ffff:0:a00:5', // IPv4-translated
      '::127.0.0.1',
      '::7f00:1',
      '::',
      '64:ff9b::10.0.0.5',
      '64:ff9b::a9fe:a9fe', // NAT64 for 169.254.169.254
      '2002:a00:5::1', // 6to4 for 10.0.0.5
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['::ffff:93.184.216.34', '::ffff:5db8:d822', '64:ff9b::5db8:d822', '2002:5db8:d822::1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses multicast, site-local, local-use NAT64, a zone id on link-local, and what is not an address', () => {
    for (const ip of ['ff02::1', 'fec0::1', '64:ff9b:1::a', 'fe80::1%eth0', 'not-an-ip', '1.2.3', '256.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});
