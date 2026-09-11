/**
 * Turn a picked image File into a small inline data URL — in the browser.
 *
 * There is no file storage in this product. What comes out of here is stored
 * verbatim in a TEXT column and rendered straight into `src` on the public
 * booking page, so its SIZE is the invitee's download, not the host's upload.
 * That is why the old 1MB input cap existed, and why simply raising it was not
 * an option: a 25MB photo is ~33MB of base64 inside the page's own document.
 *
 * So the cap moves. We accept a big file and make it small before encoding:
 * decode it, draw it down to a sane pixel budget, re-encode as WebP. A 25MB
 * phone photo lands at roughly 50KB — comfortably under the stored cap, and the
 * public page gets FASTER rather than slower.
 *
 * It lives here, in one file, rather than in each form, because two forms
 * already disagreed about the limit (1_000_000 in one, 1024 * 1024 in the
 * other) and the next form would have re-decided a third time.
 *
 * Browser-only: it uses `createImageBitmap` and a canvas. Import it from client
 * components.
 */

import { MAX_INLINE_IMAGE_CHARS } from '@slate/types';

/**
 * A stable code the caller localizes — never a user-facing string.
 *
 * `tooLarge` means the FILE is too big to open at all, which is the only case
 * that can name the 25MB number. `cannotShrink` is the separate, rarer case
 * where the file opened fine but nothing we can store came out the other side —
 * a vector too big to keep verbatim, or a raster that stayed over the cap even
 * at the bottom of the quality ladder. Telling that host to pick something
 * under 25MB would be false advice.
 */
export type ImageErrorCode = 'invalid' | 'tooLarge' | 'cannotShrink' | 'read';

export type ReadImageResult = { ok: true; dataUrl: string } | { ok: false; code: ImageErrorCode };

/**
 * What a surface wants its stored image to be.
 *
 * Not one size for everything: the studio's image control drives BOTH the
 * round avatar and the wide cover banner, and squaring a cover to 512×512 would
 * destroy it. Each target says how the picture is displayed, so the stored
 * pixels match what the page actually draws.
 */
export type ImageTarget = 'avatar' | 'logo' | 'cover';

/**
 * The largest FILE we will ask the browser to decode. Past this the decode
 * itself is the problem — the tab has to hold the decompressed bitmap — so the
 * rejection stays, it just fires 25× later than it used to.
 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * The largest STRING we will hand the server — the contract's own cap, imported
 * rather than restated so the client cannot drift past what the server accepts.
 * After downscaling nothing legitimate comes close; this is the backstop for
 * the path that skips the canvas (SVG) and for a pathological encode.
 */
export const MAX_STORED_IMAGE_CHARS = MAX_INLINE_IMAGE_CHARS;

/**
 * `crop: true` fills the box and trims the overflow — right for a photo shown
 * in a circle. `crop: false` fits the whole picture inside the box, which keeps
 * a wide wordmark or a banner intact and lets CSS `object-cover` do the
 * trimming at display time, exactly as it does today.
 */
const TARGETS: Record<ImageTarget, { w: number; h: number; crop: boolean }> = {
  avatar: { w: 512, h: 512, crop: true },
  logo: { w: 512, h: 512, crop: false },
  cover: { w: 1600, h: 1600, crop: false },
};

/** Quality ladder: only ever walked if the first encode somehow busts the cap. */
const QUALITY_STEPS = [0.85, 0.7, 0.55];

/** Cached WebP-encode support; `undefined` until the first encode probes it. */
let webpSupported: boolean | undefined;

/** Test seam: forget the cached probe. */
export function resetWebpProbe(): void {
  webpSupported = undefined;
}

/**
 * Decode to a bitmap with EXIF rotation APPLIED.
 *
 * A phone photo carries its rotation as a flag rather than in the pixels, and
 * `drawImage` ignores the flag — every portrait selfie would land sideways.
 * `imageOrientation: 'from-image'` is the whole fix and it must not be dropped.
 */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older engines without the option: fall back to an <img>, which browsers
    // auto-orient themselves. Slower, and no help if the decode is what failed.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function sizeOf(src: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  return src instanceof HTMLImageElement
    ? { w: src.naturalWidth, h: src.naturalHeight }
    : { w: src.width, h: src.height };
}

/**
 * Where the source pixels go and how big the result is — the whole geometry
 * decision, as arithmetic.
 *
 * Split out from the drawing so it can be tested without a DOM: this is the
 * part that decides whether a cover keeps its aspect ratio and whether a small
 * picture gets blown up, and both are easy to regress invisibly.
 *
 * `src` is the rectangle to take FROM the source (a centred square when
 * cropping, the whole thing otherwise); `width`/`height` are the canvas.
 */
export function planDraw(
  target: ImageTarget,
  sw: number,
  sh: number,
  scale = 1,
): { width: number; height: number; src: { x: number; y: number; w: number; h: number } } | null {
  if (!sw || !sh) return null;
  const spec = TARGETS[target];

  if (spec.crop) {
    // Fill a square and trim the overflow. `Math.min(..., sw, sh)` is what
    // stops a small picture being upscaled into a blurry one.
    const edge = Math.min(sw, sh);
    const side = Math.max(1, Math.round(Math.min(spec.w, edge) * scale));
    return {
      width: side,
      height: side,
      src: { x: (sw - edge) / 2, y: (sh - edge) / 2, w: edge, h: edge },
    };
  }

  // Keep the whole picture and its aspect ratio, capping the longest edge.
  // The `1` in the min is again the no-upscaling rule.
  const fit = Math.min(spec.w / sw, spec.h / sh, 1) * scale;
  return {
    width: Math.max(1, Math.round(sw * fit)),
    height: Math.max(1, Math.round(sh * fit)),
    src: { x: 0, y: 0, w: sw, h: sh },
  };
}

/** Draw `src` into a canvas of the planned geometry. */
function drawDown(
  src: ImageBitmap | HTMLImageElement,
  target: ImageTarget,
  scale: number,
): HTMLCanvasElement | null {
  const { w: sw, h: sh } = sizeOf(src);
  const plan = planDraw(target, sw, sh, scale);
  if (!plan) return null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = plan.width;
  canvas.height = plan.height;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    src,
    plan.src.x,
    plan.src.y,
    plan.src.w,
    plan.src.h,
    0,
    0,
    plan.width,
    plan.height,
  );
  return canvas;
}

/**
 * Encode, preferring WebP.
 *
 * `toDataURL('image/webp')` does not fail when WebP is unavailable — it
 * silently hands back a PNG — so the prefix is the only honest test. The JPEG
 * fallback has NO alpha channel, and an un-composited transparent logo encodes
 * its transparent pixels as BLACK. So the fallback redraws on white first.
 */
export function encode(canvas: HTMLCanvasElement, quality: number): string {
  // Probed once per page: on an engine without WebP, asking again on every
  // rung of the quality ladder encodes and discards a full PNG each time.
  if (webpSupported !== false) {
    const webp = canvas.toDataURL('image/webp', quality);
    webpSupported = webp.startsWith('data:image/webp');
    if (webpSupported) return webp;
  }

  const onWhite = document.createElement('canvas');
  onWhite.width = canvas.width;
  onWhite.height = canvas.height;
  const ctx = onWhite.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, onWhite.width, onWhite.height);
  ctx.drawImage(canvas, 0, 0);
  return onWhite.toDataURL('image/jpeg', quality);
}

/**
 * Read a picked file into a stored-ready data URL.
 *
 * Two shapes never reach the canvas:
 *   - SVG has no intrinsic pixel size, so `drawImage` has nothing to scale from
 *     and the result is unpredictable. A vector is already small, so it is kept
 *     exactly as picked and only has to clear the stored cap.
 *   - An animated GIF decodes to its FIRST FRAME. That is fine for an avatar,
 *     but it has to be said in the help text rather than discovered.
 */
export async function readImageFile(file: File, target: ImageTarget): Promise<ReadImageResult> {
  if (!file.type.startsWith('image/')) return { ok: false, code: 'invalid' };
  // Before anything reads the file — including the SVG path, which would
  // otherwise pull a 40MB document into memory only to reject it afterwards.
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, code: 'tooLarge' };

  if (file.type === 'image/svg+xml') {
    const dataUrl = await readAsDataUrl(file);
    if (!dataUrl) return { ok: false, code: 'read' };
    return dataUrl.length > MAX_STORED_IMAGE_CHARS
      ? { ok: false, code: 'cannotShrink' }
      : { ok: true, dataUrl };
  }

  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await decode(file);
  } catch {
    return { ok: false, code: 'read' };
  }

  try {
    // Full target size at the best quality is the normal path and exits on the
    // first pass. The ladder below only runs if that busts the stored cap.
    for (const scale of [1, 0.5]) {
      const canvas = drawDown(src, target, scale);
      if (!canvas) return { ok: false, code: 'read' };
      for (const quality of QUALITY_STEPS) {
        const dataUrl = encode(canvas, quality);
        if (dataUrl.length <= MAX_STORED_IMAGE_CHARS) return { ok: true, dataUrl };
      }
    }
    return { ok: false, code: 'cannotShrink' };
  } catch {
    // The contract of this function is that it RESOLVES with a code. A throw
    // from the canvas escapes both call sites' `finally`-only handling and
    // leaves a control that silently does nothing.
    return { ok: false, code: 'read' };
  } finally {
    if (!(src instanceof HTMLImageElement)) src.close();
  }
}

/**
 * The file's bytes as a `data:` URL, via `arrayBuffer` rather than
 * `FileReader`. Both work in a browser; only this one also works under the
 * web app's plain-node test environment, which is what makes the vector path
 * testable at all.
 */
async function readAsDataUrl(file: File): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Chunked: `String.fromCharCode(...bytes)` blows the argument limit well
    // below the sizes allowed here.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${file.type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
