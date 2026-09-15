import { describe, it, expect } from 'vitest';

import { planDraw, readImageFile } from './image-file';

/**
 * The geometry, which is the part that regresses invisibly.
 *
 * These run in plain node (the web app's vitest has no DOM), which is exactly
 * why the arithmetic was split out of the drawing: a cover that quietly starts
 * cropping, or a small logo that starts being upscaled into mush, are both
 * silent in a screenshot and obvious here.
 */
describe('planDraw', () => {
  it('crops an avatar to a centred square', () => {
    // A 4:3 landscape photo: the square comes from the middle, not the corner.
    const p = planDraw('avatar', 4000, 3000)!;
    expect([p.width, p.height]).toEqual([512, 512]);
    expect(p.src).toEqual({ x: 500, y: 0, w: 3000, h: 3000 });
  });

  it('crops a portrait avatar from the vertical centre', () => {
    const p = planDraw('avatar', 3000, 4000)!;
    expect([p.width, p.height]).toEqual([512, 512]);
    expect(p.src).toEqual({ x: 0, y: 500, w: 3000, h: 3000 });
  });

  it('never upscales an avatar smaller than the target', () => {
    const p = planDraw('avatar', 200, 300)!;
    expect([p.width, p.height]).toEqual([200, 200]);
  });

  it('keeps a cover’s aspect ratio instead of squaring it', () => {
    // The bug this guards: a 1600x1600 crop turns a banner into a square.
    const p = planDraw('cover', 4000, 1500)!;
    expect([p.width, p.height]).toEqual([1600, 600]);
    expect(p.width / p.height).toBeCloseTo(4000 / 1500, 5);
    expect(p.src).toEqual({ x: 0, y: 0, w: 4000, h: 1500 });
  });

  it('caps a cover’s longest edge whichever way it runs', () => {
    expect(planDraw('cover', 1500, 4000)!.height).toBe(1600);
    expect(planDraw('cover', 4000, 1500)!.width).toBe(1600);
  });

  it('keeps a wide logo whole rather than cropping it to a square', () => {
    const p = planDraw('logo', 900, 300)!;
    expect([p.width, p.height]).toEqual([512, 171]);
    expect(p.src).toEqual({ x: 0, y: 0, w: 900, h: 300 });
  });

  it('never upscales a small logo', () => {
    const p = planDraw('logo', 120, 40)!;
    expect([p.width, p.height]).toEqual([120, 40]);
  });

  it('applies the fallback scale step', () => {
    expect(planDraw('avatar', 4000, 3000, 0.5)!.width).toBe(256);
    expect(planDraw('cover', 4000, 1500, 0.5)!.width).toBe(800);
  });

  it('never returns a zero dimension', () => {
    const p = planDraw('cover', 4000, 1)!;
    expect(p.height).toBeGreaterThanOrEqual(1);
    expect(p.width).toBeGreaterThanOrEqual(1);
  });

  it('refuses a source with no pixels', () => {
    expect(planDraw('avatar', 0, 0)).toBeNull();
  });
});

/**
 * The gates that run BEFORE any canvas, so they need no DOM. Each one is a
 * branch a caller relies on to show the right message.
 */
describe('readImageFile gates', () => {
  const fileOf = (bytes: number, type: string) =>
    new File([new Uint8Array(bytes)], 'x', { type });

  it('rejects a file that is not an image', async () => {
    await expect(readImageFile(fileOf(10, 'application/pdf'), 'avatar')).resolves.toEqual({
      ok: false,
      code: 'invalid',
    });
  });

  it('rejects a file too large to decode', async () => {
    const huge = fileOf(1, 'image/jpeg');
    Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 });
    await expect(readImageFile(huge, 'avatar')).resolves.toEqual({ ok: false, code: 'tooLarge' });
  });

  it('checks the size BEFORE reading, including for a vector', async () => {
    // The bug this guards: an oversized SVG being pulled into memory in full
    // and only rejected afterwards.
    const huge = fileOf(1, 'image/svg+xml');
    Object.defineProperty(huge, 'size', { value: 40 * 1024 * 1024 });
    await expect(readImageFile(huge, 'logo')).resolves.toEqual({ ok: false, code: 'tooLarge' });
  });

  it('keeps a small vector exactly as picked, without a canvas', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    const r = await readImageFile(new File([svg], 'm.svg', { type: 'image/svg+xml' }), 'logo');
    expect(r.ok).toBe(true);
    // Still a vector: nothing rasterized it on the way through.
    expect(r.ok && r.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('distinguishes "cannot shrink" from "too large to open" for a vector', async () => {
    // Under the 25MB input cap but over the stored character cap, so telling
    // this host to pick something under 25MB would be false advice.
    const bloated = `<svg xmlns="http://www.w3.org/2000/svg">${'<!---->'.repeat(300_000)}</svg>`;
    const r = await readImageFile(new File([bloated], 'm.svg', { type: 'image/svg+xml' }), 'logo');
    expect(r).toEqual({ ok: false, code: 'cannotShrink' });
  });
});
