import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { encode, resetWebpProbe } from './image-file';

/**
 * The encode branch, which the manual browser pass proved once and which would
 * otherwise be lost on the next refactor.
 *
 * Two things matter here and neither shows up in a screenshot of the happy
 * path: `toDataURL('image/webp')` does NOT fail on an engine without WebP — it
 * silently hands back a PNG — and the JPEG fallback has no alpha channel, so a
 * transparent logo encodes its transparent pixels as BLACK unless something
 * composites it onto white first.
 *
 * The web app's vitest runs in plain node, so rather than add a DOM just for
 * this, the canvas is a recording stub: what is asserted is the DECISION and
 * the ORDER of operations, which is the part that regresses. The pixels
 * themselves were verified in a real browser.
 */

interface Call {
  op: string;
  args: unknown[];
}

let calls: Call[];
let originalDocument: unknown;

/** A canvas-shaped stub. `encode` only touches width/height and toDataURL. */
function stubCanvas(webpWorks: boolean): HTMLCanvasElement {
  return {
    width: 64,
    height: 32,
    toDataURL(type?: string) {
      calls.push({ op: 'source.toDataURL', args: [type] });
      if (type === 'image/webp') {
        return webpWorks ? 'data:image/webp;base64,AA' : 'data:image/png;base64,AA';
      }
      return `data:${type};base64,AA`;
    },
  } as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  calls = [];
  resetWebpProbe();
  originalDocument = (globalThis as { document?: unknown }).document;
  // The fallback builds its own white canvas through `document.createElement`.
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        imageSmoothingQuality: '',
        fillRect: (...args: unknown[]) => calls.push({ op: 'fillRect', args }),
        drawImage: (...args: unknown[]) => calls.push({ op: 'drawImage', args }),
      }),
      toDataURL: (type?: string) => {
        calls.push({ op: 'white.toDataURL', args: [type] });
        return `data:${type};base64,AA`;
      },
    }),
  };
});

afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
});

describe('encode', () => {
  it('uses WebP when the engine can actually produce it', () => {
    const out = encode(stubCanvas(true), 0.85);
    expect(out.startsWith('data:image/webp')).toBe(true);
    // No fallback canvas was built.
    expect(calls.some((c) => c.op === 'white.toDataURL')).toBe(false);
  });

  it('falls back to JPEG when WebP silently returns a PNG', () => {
    const out = encode(stubCanvas(false), 0.85);
    expect(out.startsWith('data:image/jpeg')).toBe(true);
  });

  it('paints white BEFORE drawing, so transparency cannot come out black', () => {
    encode(stubCanvas(false), 0.85);
    const fill = calls.findIndex((c) => c.op === 'fillRect');
    const draw = calls.findIndex((c) => c.op === 'drawImage');
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(draw).toBeGreaterThan(fill);
  });

  it('covers the whole canvas with white, not a corner of it', () => {
    encode(stubCanvas(false), 0.85);
    expect(calls.find((c) => c.op === 'fillRect')?.args).toEqual([0, 0, 64, 32]);
  });

  it('probes WebP once, not on every rung of the quality ladder', () => {
    const canvas = stubCanvas(false);
    encode(canvas, 0.85);
    encode(canvas, 0.7);
    encode(canvas, 0.55);
    const probes = calls.filter((c) => c.op === 'source.toDataURL' && c.args[0] === 'image/webp');
    expect(probes).toHaveLength(1);
  });
});
