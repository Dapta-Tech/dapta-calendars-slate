import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Figtree, IBM_Plex_Mono } from 'next/font/google';
import 'primeicons/primeicons.css';
import './globals.css';

/**
 * Figtree — the brand face, and the voice that does all the talking.
 *
 * A geometric-humanist sans under the SIL Open Font License. The license is the
 * reason it is here rather than a commercial face: `next/font/google` downloads it
 * at BUILD time and serves it from our own origin, so the font files ship inside
 * the deployed app and inside every clone of this repository, and a public booking
 * page makes no third-party font request. Only a freely-redistributable license
 * makes that legal, and OFL is one.
 *
 * It is a variable font, so no `weight` is declared — the whole 300–900 axis
 * arrives in one file and the type scale draws 400 body / 500 labels / 600 titles
 * / 700 buttons off it.
 */
const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
});

/**
 * IBM Plex Mono — the voice for things you copy rather than read.
 *
 * Its whole job is the fixed advance and the unambiguous `l`/`1`/`O`/`0`: public
 * links, handles, and the interpolation tokens in the notification template
 * editor, which already asked for `font-mono` and until now got whatever the
 * browser happened to default to. Numbers are NOT one of those — a stat is glanced
 * at, and monospacing one only makes it read as a code sample.
 *
 * Not preloaded: it paints a handful of short strings rather than page furniture,
 * so most routes never need it and the ones that do can swap.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
  preload: false,
});

// Customer-facing name comes from the deployment (NEXT_PUBLIC_PRODUCT_NAME,
// inlined at build time) — "Dapta Calendars" in Dapta's builds, "Calendars"
// for a bare fork. "Slate" is the internal/repo identifier only and must
// never surface in the UI.
const productName = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';

// Absolute base for OG/twitter URLs (PUBLIC_APP_URL is the deployment's public
// web origin — already in .env for manage/booking links). Bad value → localhost.
function appBaseUrl(): URL {
  try {
    return new URL(process.env.PUBLIC_APP_URL || 'http://localhost:3000');
  } catch {
    return new URL('http://localhost:3000');
  }
}

export const metadata: Metadata = {
  metadataBase: appBaseUrl(),
  title: `${productName} — open-source scheduling`,
  description: `${productName} is open-source scheduling. Clone, run, and book — anywhere.`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `data-theme="dark"` stays hardcoded here on purpose. The light half of the
    // token sheet is authored and unit-tested but deliberately unreachable until
    // the theme cookie, the server-stamped attribute and the toggle land together.
    <html
      lang="en"
      data-theme="dark"
      className={`${figtree.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground">{children}</body>
    </html>
  );
}
