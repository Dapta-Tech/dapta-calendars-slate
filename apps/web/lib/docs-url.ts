import 'server-only';
import type { Locale } from '@slate/shared';

/**
 * Where the rail's "Docs" item points, resolved from the SERVER's runtime
 * environment in the reader's language.
 *
 *   DOCS_URL       the documentation, and the fallback for every language
 *   DOCS_URL_ES    the Spanish documentation (one `DOCS_URL_<LOCALE>` per language)
 *
 * Runtime, never `NEXT_PUBLIC_*`, for the same reason as the MCP address
 * (`mcp-config.ts`): one image serves every environment, and the docs move
 * (a new section, a new domain) without a rebuild.
 *
 * Nothing set gives `null` and the rail shows no Docs item. That is the
 * open-core default on purpose: a fork has no docs site of its own until it
 * says so, and pointing its users at the upstream product's documentation
 * would describe a deployment that is not theirs. Anything that is not an
 * http(s) URL counts as unset, so a typo hides the item instead of rendering a
 * link that goes nowhere.
 */
export function resolveDocsUrl(locale: Locale, env: Record<string, string | undefined> = process.env): string | null {
  return clean(env[`DOCS_URL_${locale.toUpperCase()}`]) ?? clean(env.DOCS_URL);
}

/**
 * The docs URL tagged as a click from this app's sidebar, the same tags the
 * app switcher puts on its suite links (`utm_source=calendars`), so the docs
 * site can tell the product's own readers from search traffic.
 */
export function docsNavHref(locale: Locale, env: Record<string, string | undefined> = process.env): string | null {
  const base = resolveDocsUrl(locale, env);
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('utm_source', 'calendars');
  url.searchParams.set('utm_medium', 'sidebar');
  return url.toString();
}

function clean(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
