import { getMessages, t } from '@slate/shared';
import { signupHref } from '@/lib/growth';
import { PRODUCT_NAME } from '@/lib/product-name';
import { BrandMark, IS_DAPTA_BRAND } from '@/components/brand/brand';

/**
 * "Made with dCal.ai by Dapta": the growth-loop attribution on every public
 * surface (R11). The copy names the product AND the company on a Dapta build,
 * the way dForms signs its forms; a fork's pill names the fork's own product
 * (`{product}`), never dCal or Dapta. A discreet centered footer pill: semantic tokens only, so it
 * follows dark/light and any host branding without competing with it. Renders
 * only when the deployment configures NEXT_PUBLIC_SIGNUP_URL, never when
 * NEXT_PUBLIC_HIDE_BADGE is set (open-core: forks aren't forced to carry
 * Dapta branding), and never on the page of an account that turned the
 * branding off while it is a paying Dapta AI customer (`show`).
 */
export function MadeWithBadge({
  locale = 'en',
  accountCode,
  show,
}: {
  locale?: string;
  accountCode?: string | null;
  /** The page's `showBranding` (see `signupHref`). False renders nothing. */
  show: boolean;
}) {
  const href = signupHref('badge', accountCode, show);
  if (!href) return null;
  const m = getMessages(locale).growth;
  return (
    // `bp-embed-footer` is inert outside an embed — it exists so the inline
    // embed can trim this footer's padding without the badge itself knowing
    // anything about embed mode (globals.css, `.dc-embed`).
    <footer className="bp-embed-footer flex justify-center px-6 pb-8 pt-4">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        // Counted by the page's anonymous analytics (`VisitorAnalytics`), with
        // the medium read off this link's own UTM tags.
        data-analytics-cta=""
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        {/* The drawn mark, not a pasted PNG: it is ink in `currentColor`, so it
            follows the badge's own text colour on either canvas. Only on a
            Dapta build: the PNG it replaces was Dapta's artwork on every fork
            that set a signup URL, and the brand gate's letter chip is a heading
            mark, too heavy for a 12px footer line. A fork's badge is its words. */}
        {IS_DAPTA_BRAND ? <BrandMark className="h-3.5 w-auto shrink-0" /> : null}
        <span>{IS_DAPTA_BRAND ? m.madeWithDapta : t(m.madeWith, { product: PRODUCT_NAME })}</span>
        {/* In the page's language, like the words beside it: a Spanish page
            whose badge ends in English reads as two products to a screen reader. */}
        <span className="sr-only">{m.ctaOpensNewTab}</span>
      </a>
    </footer>
  );
}
