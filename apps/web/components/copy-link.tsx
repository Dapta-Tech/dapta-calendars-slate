'use client';

import { useEffect, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const stripProtocol = (u: string) => u.replace(/^https?:\/\//, '');

/** The booking link with a copy-to-clipboard button (F1). Absolute URL resolved
 *  client-side from the real origin; a 2s "Copied" flash confirms (R22).
 *  The displayed text starts as the server-stable `path` so SSR and the first
 *  client render match (no hydration mismatch), then upgrades to the absolute
 *  origin after mount.
 *
 *  A2 (#112): the two actions are real controls. "Open" was a text link wearing
 *  an arrow — `Open →` — which is neither a link affordance nor a button one; it
 *  is now a ghost `Button` carrying the design language's own open-in-new-tab
 *  icon. Both sit on the 44px step, and the URL is `font-mono` because it is a
 *  string you copy rather than read (F's second voice). */
export function CopyLink({
  path,
  labels,
}: {
  path: string;
  /** i18n'd button labels; English fallbacks keep old call sites working. */
  labels?: { copy: string; copied: string; open: string; opensNewTab?: string };
}) {
  const [copied, setCopied] = useState(false);
  const [display, setDisplay] = useState(() => stripProtocol(path));

  useEffect(() => {
    setDisplay(stripProtocol(`${window.location.origin}${path}`));
  }, [path]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    // Wraps at 360px: the URL takes the first line and the two controls the next,
    // rather than the code element being squeezed to nothing.
    <div className="flex flex-wrap items-center gap-inline">
      <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-inline py-inline font-mono text-xs text-foreground">
        {display}
      </code>
      <Button variant="outline" size="lg" onClick={copy} className="shrink-0">
        <i aria-hidden className={`pi ${copied ? 'pi-check' : 'pi-copy'}`} style={{ fontSize: 14 }} />
        {copied ? (labels?.copied ?? 'Copied') : (labels?.copy ?? 'Copy')}
      </Button>
      <a
        href={path}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), 'shrink-0')}
      >
        <i aria-hidden className="pi pi-external-link" style={{ fontSize: 14 }} />
        {labels?.open ?? 'Open'}
        <span className="sr-only"> ({labels?.opensNewTab ?? 'opens in a new tab'})</span>
      </a>
    </div>
  );
}
