'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * App-switcher — the discreet exit to the wider Dapta suite (ported from the
 * old Angular app's R16 switcher). An Atlassian-style grid affordance next to
 * the product wordmark that opens a small menu:
 *   • <product> (current)  • Dapta (→ platform, new tab, UTM-tagged)  • Forms (soon)
 *
 * Growth-loop only — hidden entirely when NEXT_PUBLIC_PLATFORM_URL is unset
 * (white-label / self-host builds), so the switcher never dead-ends on a lone
 * "current" row. Tokens only; WAI-ARIA menu-button pattern (Escape / outside
 * click dismiss, focus first item on open).
 */

interface SwitcherMessages {
  trigger: string;
  menuLabel: string;
  eyebrow: string;
  comingSoon: string;
  opensNewTab: string;
  forms: string;
}

const PRODUCT_NAME = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Calendars';
const PLATFORM_URL = process.env.NEXT_PUBLIC_PLATFORM_URL || '';

/** app.dapta.ai carrying the app-switcher UTM tags (growth-loop measurement). */
function platformHref(base: string): string {
  try {
    const url = new URL(base);
    url.searchParams.set('utm_source', 'calendars');
    url.searchParams.set('utm_medium', 'app_switcher');
    return url.toString();
  } catch {
    return base;
  }
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function AppSwitcher({
  messages: m,
  collapsed = false,
}: {
  messages: SwitcherMessages;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // No platform configured → the switcher would only show "current"; hide it.
  const hasPlatform = PLATFORM_URL.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  if (!hasPlatform) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={m.trigger}
        title={m.trigger}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]"
      >
        <GridIcon className="h-[18px] w-[18px]" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={m.menuLabel}
          className={`absolute z-50 mt-2 w-60 rounded-md border border-border bg-popover p-1.5 text-popover-foreground shadow-lg ${
            collapsed ? 'left-0' : 'left-0'
          }`}
        >
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {m.eyebrow}
          </p>

          {/* Current product */}
          <span
            role="menuitem"
            tabIndex={-1}
            aria-current="true"
            className="flex items-center gap-2.5 rounded-sm bg-muted px-2 py-2 text-sm font-medium"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
              {PRODUCT_NAME.charAt(0)}
            </span>
            <span className="flex-1 truncate">{PRODUCT_NAME}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-primary" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>

          {/* Dapta (external, new tab) */}
          <a
            role="menuitem"
            tabIndex={-1}
            href={platformHref(PLATFORM_URL)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-sm px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">
              D
            </span>
            <span className="flex-1 truncate">Dapta</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-muted-foreground" aria-hidden>
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
            <span className="sr-only">{m.opensNewTab}</span>
          </a>

          {/* Forms (coming soon) */}
          <span
            role="menuitem"
            tabIndex={-1}
            aria-disabled="true"
            className="flex items-center gap-2.5 rounded-sm px-2 py-2 text-sm text-muted-foreground"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
            </span>
            <span className="flex-1 truncate">{m.forms}</span>
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {m.comingSoon}
            </span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
