import { getMessages } from '@slate/shared';
import { showBadge, signupHref } from '@/lib/growth';

/**
 * "Made with Dapta Calendars" — the growth-loop attribution on every public
 * surface (R11). A discreet centered footer pill: semantic tokens only, so it
 * follows dark/light and any host branding without competing with it. Hidden
 * entirely when NEXT_PUBLIC_HIDE_BADGE is set (open-core: forks aren't forced
 * to carry Dapta branding).
 */
export function MadeWithBadge({
  locale = 'en',
  accountCode,
}: {
  locale?: string;
  accountCode?: string | null;
}) {
  if (!showBadge) return null;
  const m = getMessages(locale).growth;
  return (
    <footer className="flex justify-center px-6 pb-8 pt-4">
      <a
        href={signupHref('badge', accountCode)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      >
        <img
          src="/dapta-mark.png"
          alt=""
          width={14}
          height={14}
          className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain"
        />
        <span>{m.madeWith}</span>
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </footer>
  );
}
