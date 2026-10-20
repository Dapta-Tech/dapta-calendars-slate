'use client';

import { useCallback, useRef, useState } from 'react';
import { BrandMark, IS_DAPTA_BRAND, PRODUCT_NAME } from '@/components/brand/brand';
import { AnchoredMenu } from '@/components/ui/anchored-menu';

/**
 * App-switcher — the discreet exit to the wider Dapta suite (ported from the
 * old Angular app's R16 switcher). An Atlassian-style grid affordance next to
 * the product wordmark that opens a small menu:
 *   • Dapta (→ platform, new tab, UTM-tagged)  • <product> (current)  • Forms
 *
 * Forms is a link (new tab, UTM-tagged) when the deployment says where it lives
 * (NEXT_PUBLIC_FORMS_URL), and a "Coming soon" row only when it does not. The
 * same rule the Forms app follows for its own Calendars row.
 *
 * Growth-loop only: hidden entirely when NEITHER suite URL is set (white-label
 * / self-host builds), so the switcher never dead-ends on a lone "current" row.
 * Tokens only; WAI-ARIA menu-button pattern (Escape / outside click dismiss,
 * focus first item on open). The menu is an `AnchoredMenu`: portalled out of the
 * rail, which scrolls and would otherwise clip it, in the drawer as on desktop.
 */

interface SwitcherMessages {
  trigger: string;
  menuLabel: string;
  eyebrow: string;
  comingSoon: string;
  opensNewTab: string;
  forms: string;
}

// Full static property accesses, so Next inlines them into the client bundle.
const PLATFORM_URL = process.env.NEXT_PUBLIC_PLATFORM_URL || '';
const FORMS_URL = process.env.NEXT_PUBLIC_FORMS_URL || '';

/**
 * Forms' own name: "dForms" on Dapta's build, the catalog's neutral "Forms" on a
 * fork that points the switcher at a forms app of its own. The same split the
 * Forms app makes for its own name (`IS_DAPTA_BRAND`).
 */
const formsName = (catalogName: string) => (IS_DAPTA_BRAND ? 'dForms' : catalogName);

/** A suite URL (platform or Forms) carrying the app-switcher UTM tags. */
function suiteHref(base: string): string {
  try {
    const url = new URL(base);
    url.searchParams.set('utm_source', 'calendars');
    url.searchParams.set('utm_medium', 'app_switcher');
    return url.toString();
  } catch {
    return base;
  }
}

export function AppSwitcher({ messages: m }: { messages: SwitcherMessages }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // No suite configured → the switcher would only show "current"; hide it.
  const hasSuite = PLATFORM_URL.length > 0 || FORMS_URL.length > 0;

  if (!hasSuite) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={m.trigger}
        title={m.trigger}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-[0.98]"
      >
        <i aria-hidden className="pi pi-th-large" style={{ fontSize: 18 }} />
      </button>

      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={close}
        label={m.menuLabel}
        width={240}
        autoFocus
        className="p-inline"
        testId="app-switcher-menu"
      >
        <p className="px-inline py-tight text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {m.eyebrow}
        </p>

        {/* Dapta AI, the platform (external, new tab). First, per Felipe. */}
        {PLATFORM_URL ? (
          <a
            role="menuitem"
            tabIndex={-1}
            href={suiteHref(PLATFORM_URL)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="flex items-center gap-field min-h-control rounded-sm px-inline py-inline text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {/* Tiled, as every row is: `dapta-mark.png` is fixed white artwork, so
                bare on the light popover it was white on white. `bg-brand-ink`
                is the one ground that does not flip with the theme (the same
                fix the Forms switcher carries). */}
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-ink">
              <img src="/dapta-mark.png" alt="" width={16} height={16} className="h-4 w-4 object-contain" />
            </span>
            <span className="flex-1 truncate">Dapta AI</span>
            <i aria-hidden className="pi pi-external-link text-muted-foreground" style={{ fontSize: 13 }} />
            <span className="sr-only">{m.opensNewTab}</span>
          </a>
        ) : null}

        {/* Current product */}
        <span
          role="menuitem"
          tabIndex={-1}
          aria-current="true"
          className="flex items-center gap-field min-h-control rounded-sm bg-muted px-inline py-inline text-sm font-medium"
        >
          {/* The dark tile is for the drawn mark; a fork's letter chip already
              carries its own fill and sits on the row like the other items. */}
          {IS_DAPTA_BRAND ? (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-ink">
              <BrandMark className="h-3.5 w-auto text-brand-ink-foreground" />
            </span>
          ) : (
            <BrandMark />
          )}
          <span className="flex-1 truncate">{PRODUCT_NAME}</span>
          <i aria-hidden className="pi pi-check text-primary" style={{ fontSize: 14 }} />
        </span>

        {/* Forms: the sibling sidecar (external, new tab) where the deployment
            has one; a "Coming soon" row otherwise. */}
        {FORMS_URL ? (
          <a
            role="menuitem"
            tabIndex={-1}
            href={suiteHref(FORMS_URL)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            className="flex items-center gap-field min-h-control rounded-sm px-inline py-inline text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-ink text-brand-ink-foreground" aria-hidden>
              <i className="pi pi-file-edit" style={{ fontSize: 13 }} />
            </span>
            <span className="flex-1 truncate">{formsName(m.forms)}</span>
            <i aria-hidden className="pi pi-external-link text-muted-foreground" style={{ fontSize: 13 }} />
            <span className="sr-only">{m.opensNewTab}</span>
          </a>
        ) : (
          <span
            role="menuitem"
            tabIndex={-1}
            aria-disabled="true"
            className="flex items-center gap-field min-h-control rounded-sm px-inline py-inline text-sm text-muted-foreground"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground" aria-hidden>
              <i className="pi pi-file-edit" style={{ fontSize: 13 }} />
            </span>
            <span className="flex-1 truncate">{formsName(m.forms)}</span>
            <span className="rounded-full border border-border px-inline py-tight text-2xs font-medium uppercase tracking-wide">
              {m.comingSoon}
            </span>
          </span>
        )}
      </AnchoredMenu>
    </>
  );
}
