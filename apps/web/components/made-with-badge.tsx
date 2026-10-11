import { getMessages } from '@slate/shared';
import { signupHref } from '@/lib/growth';
import { BrandMark, IS_DAPTA_BRAND } from '@/components/brand/brand';

/**
 * "Made with Dapta Calendars": the growth-loop attribution on every public
 * surface (R11). A discreet centered footer pill: semantic tokens only, so it
 * follows dark/light and any host branding without competing with it. Renders
 * only when the deployment configures NEXT_PUBLIC_SIGNUP_URL, and never when
 * NEXT_PUBLIC_HIDE_BADGE is set (open-core: forks aren't forced to carry
 * Dapta branding).
 */
export function MadeWithBadge({
  locale = 'en',
  accountCode,
}: {
  locale?: string;
  accountCode?: string | null;
}) {
  const href = signupHref('badge', accountCode);
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
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        {/* The drawn mark, not a pasted PNG: it is ink in `currentColor`, so it
            follows the badge's own text colour on either canvas. Only on a
            Dapta build: the PNG it replaces was Dapta's artwork on every fork
            that set a signup URL, and the brand gate's letter chip is a heading
            mark, too heavy for a 12px footer line. A fork's badge is its words. */}
        {IS_DAPTA_BRAND ? <BrandMark className="h-3.5 w-auto shrink-0" /> : null}
        <span>{m.madeWith}</span>
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </footer>
  );
}
