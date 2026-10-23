import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { Figtree } from 'next/font/google';
import { getMessages, t } from '@slate/shared';
import './icons.css';
import { ErrorAnalytics } from '@/components/analytics/error-analytics';
import { LangStamp } from '@/components/lang-stamp';
import { errorAnalyticsConfig } from '@/lib/analytics/config';
import { ThemeStamp } from '@/components/theme-stamp';
import { deploymentNoindex } from '@/lib/indexing';
import { documentLangAnswers, documentLocale } from '@/lib/locale';
import { PRODUCT_NAME } from '@/lib/product-name';
import { isPublicDocument, resolveDocumentTheme } from '@/lib/theme.server';
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

// Absolute base for OG/twitter URLs (PUBLIC_APP_URL is the deployment's public
// web origin — already in .env for manage/booking links). Bad value → localhost.
function appBaseUrl(): URL {
  try {
    return new URL(process.env.PUBLIC_APP_URL || 'http://localhost:3000');
  } catch {
    return new URL('http://localhost:3000');
  }
}

/**
 * The defaults every page inherits until it names itself: the product's own
 * title and description, in the document's language, around the name the
 * deployment set (`PRODUCT_NAME`; "Slate" is the repo's codename and never
 * surfaces). A deployment marked `NOINDEX` says so here too, and every page
 * inherits it; a page that sets its own `robots` (an embed) only ever narrows it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const site = getMessages(await documentLocale()).site;
  return {
    metadataBase: appBaseUrl(),
    title: t(site.title, { product: PRODUCT_NAME }),
    description: t(site.description, { product: PRODUCT_NAME }),
    ...(deploymentNoindex() ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The document theme, resolved on the SERVER and stamped before the response
  // is sent — so the palette a host chose is the FIRST thing painted and a full
  // load never flashes the other one.
  //
  // This layout wraps both audiences: the admin, login and onboarding on one
  // side, the four public booking routes and `manage/[uid]` on the other. Which
  // question gets asked is decided by the route, in `resolveDocumentTheme` —
  // ADR 0004 forbids the booking page from inheriting the host's own product
  // theme, so a bare `data-theme={cookie}` here is not a smaller version of this
  // change, it is the specific change the ADR exists to prevent.
  //
  // `suppressHydrationWarning` stays: `ThemeToggle` mutates this exact attribute
  // on the client so the flip is a repaint rather than a navigation.
  //
  // `lang` is asked the same way: the admin's language on a product route, the
  // language the visitor's page renders in on a public one (`documentLocale`),
  // so a Spanish booking page is a Spanish document to a screen reader and a
  // search engine, not an English one with Spanish words in it. `LangStamp`
  // keeps it right across client navigations, as `ThemeStamp` does the theme.
  const [theme, isPublic, locale, langAnswers] = await Promise.all([
    resolveDocumentTheme(),
    isPublicDocument(),
    documentLocale(),
    documentLangAnswers(),
  ]);

  // `bp-ground` on a public document gives `<html>` and `<body>` the booking
  // page's palette (tokens.css), so a route's skeleton, error boundary and the
  // body behind a short page all sit on the ground the page itself paints.
  // `ThemeStamp` and `CanvasStamp` keep it right across soft navigations.
  return (
    <html
      lang={locale}
      data-theme={theme}
      className={isPublic ? `${figtree.variable} bp-ground` : figtree.variable}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-foreground">
        {/* `<html>` is committed once and preserved across soft navigations, so
            the server stamp above is only right until the first `<Link>` that
            crosses between the product and a booking page. This re-derives it
            from the route on the client. */}
        <ThemeStamp />
        {/* Error tracking's settings for the error boundaries, read at request
            time; null (renders and loads nothing) unless it is on. */}
        <ErrorAnalytics config={errorAnalyticsConfig()} />
        {/* It reads the query, so it sits in its own boundary: a route that is
            ever prerendered keeps its HTML, and this simply runs in the browser. */}
        <Suspense fallback={null}>
          <LangStamp product={langAnswers.product} visitor={langAnswers.visitor} />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
