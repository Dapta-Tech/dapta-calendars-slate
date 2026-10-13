import { readFileSync } from 'node:fs';

/**
 * The share card's typeface as raw font files (see `assets/fonts/README.md` for
 * why `next/font` cannot serve this surface).
 *
 * The paths are literal `new URL(..., import.meta.url)` so the bundler can see
 * them and trace both files into the standalone output; a computed path would
 * leave the deployed route reading a file that is not there.
 */
const FILES = {
  regular: new URL('../assets/fonts/figtree-400.ttf', import.meta.url),
  bold: new URL('../assets/fonts/figtree-700.ttf', import.meta.url),
} as const;

type CardFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' };

let cached: CardFont[] | null = null;

function bytes(url: URL): ArrayBuffer {
  const b = readFileSync(url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Figtree 400 and 700 under the family name `Card`, read once per process. */
export function cardFonts(): CardFont[] {
  cached ??= [
    { name: 'Card', data: bytes(FILES.regular), weight: 400, style: 'normal' },
    { name: 'Card', data: bytes(FILES.bold), weight: 700, style: 'normal' },
  ];
  return cached;
}
