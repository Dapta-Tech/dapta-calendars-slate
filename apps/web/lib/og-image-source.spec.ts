import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardImageDataUri, isPublicAddress } from './og-image-source';

/**
 * The link preview's photo fetch is about REFUSAL: every URL it will not
 * resolve and every byte Satori cannot draw comes back as null, because the
 * alternative is a throw inside `ImageResponse` and a link with no card.
 * DNS is injected: a unit test must not depend on the machine's resolver.
 */
function respond(type: string, bytes = Buffer.from([1, 2, 3]), status = 200) {
  return new Response(bytes, { status, headers: { 'content-type': type } });
}
const publicDns = { resolve: async () => ['93.184.216.34'] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cardImageDataUri: what it draws', () => {
  it('returns the bytes inline, so Satori never fetches past the guards', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('image/jpeg')));
    await expect(cardImageDataUri('https://cdn.example.test/a.jpg', publicDns)).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    );
  });
  it('refuses redirects and never sends a referrer', async () => {
    const spy = vi.fn().mockResolvedValue(respond('image/png'));
    vi.stubGlobal('fetch', spy);
    await cardImageDataUri('https://cdn.example.test/a.png', publicDns);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: 'error', referrerPolicy: 'no-referrer' }),
    );
  });
  it('passes an uploaded PNG or JPEG data URL through without a fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(cardImageDataUri('data:image/png;base64,AAAA')).resolves.toBe('data:image/png;base64,AAAA');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('cardImageDataUri: what it refuses', () => {
  it('drops WebP, inline or fetched (the monogram draws instead)', async () => {
    await expect(cardImageDataUri('data:image/webp;base64,AAAA')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('image/webp')));
    await expect(cardImageDataUri('https://cdn.example.test/a.webp', publicDns)).resolves.toBeNull();
  });
  it('drops http, loopback, private and metadata addresses before any request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(cardImageDataUri('http://cdn.example.test/a.png', publicDns)).resolves.toBeNull();
    await expect(cardImageDataUri('https://localhost/a.png', publicDns)).resolves.toBeNull();
    await expect(cardImageDataUri('https://169.254.169.254/a.png', publicDns)).resolves.toBeNull();
    await expect(cardImageDataUri('https://[::ffff:a00:5]/a.png', publicDns)).resolves.toBeNull();
    await expect(
      cardImageDataUri('https://inward.example.test/a.png', { resolve: async () => ['10.0.0.5'] }),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('drops a non-OK response, an oversized body and a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('image/png', Buffer.from([1]), 404)));
    await expect(cardImageDataUri('https://cdn.example.test/gone.png', publicDns)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('image/png', Buffer.alloc(1_600_000, 7))));
    await expect(cardImageDataUri('https://cdn.example.test/huge.png', publicDns)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(cardImageDataUri('https://cdn.example.test/slow.png', publicDns)).resolves.toBeNull();
  });
  it('drops nothing at all', async () => {
    await expect(cardImageDataUri(null)).resolves.toBeNull();
    await expect(cardImageDataUri('   ')).resolves.toBeNull();
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
