'use client';

import { useState } from 'react';

/** The booking link with a copy-to-clipboard button (F1). Absolute URL resolved
 *  client-side from the real origin; a 2s "Copied" flash confirms (R22). */
export function CopyLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className="flex items-center gap-3">
      <code className="rounded-sm bg-muted px-2 py-1 text-sm">{url.replace(/^https?:\/\//, '')}</code>
      <button
        type="button"
        onClick={copy}
        className="rounded-md border border-border px-3 py-1 text-sm transition-transform hover:border-primary active:scale-[0.98]"
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <a href={path} className="text-sm text-primary hover:underline">
        Open →
      </a>
    </div>
  );
}
