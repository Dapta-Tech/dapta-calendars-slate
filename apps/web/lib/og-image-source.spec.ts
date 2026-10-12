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

describe('isPublicAddress', () => {
  it('classifies the ranges a card must never reach', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '2606:2800:220:1::1']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});
