'use client';

import { useEffect, useState } from 'react';

/** Must match the constants in connections-client.tsx (the opener side). */
const CONNECT_SIGNAL_CHANNEL = 'slate-connect-signal';
const CONNECT_SIGNAL_STORAGE_KEY = 'slate-connect-signal-at';

interface ConnectSignal {
  type: 'slate-connect-result';
  ok: boolean;
  message: string | null;
}

/**
 * The OAuth popup's landing page (Bug C — the popup used to strand the user
 * on Membrane's own "you can close this tab" page instead of returning to
 * Dapta Calendars). Membrane redirects the popup here as a same-origin
 * request with `?connectionId=` on success or `?error=&errorData=` on
 * failure. On mount this:
 *  1. Signals the opener with the actual outcome via BroadcastChannel AND a
 *     `localStorage` write (the `storage` event only fires in OTHER browsing
 *     contexts of the same origin — exactly the opener tab — so this is a
 *     reliable fallback where BroadcastChannel isn't available). The opener
 *     re-verifies via `discoverConnectionsAction` before trusting "success" —
 *     this signal only makes it check RIGHT AWAY instead of on the next
 *     2.5s poll tick or a window-focus event.
 *  2. On success, tries to auto-close the window immediately (it was opened
 *     via `window.open()` from a user gesture, so script-close is
 *     permitted). On failure, stays open so the user can read why, with a
 *     manual close.
 *  3. If the window is still open shortly after a success (some browsers
 *     refuse to close a window they didn't spawn, or it was reused), falls
 *     back to a visible "Close window" button — never a dead end.
 */
export function ConnectedClient({
  error,
  m,
}: {
  error: string | null;
  m: {
    title: string;
    body: string;
    close: string;
    errorTitle: string;
    errorBody: string;
  };
}) {
  const [showFallback, setShowFallback] = useState(error != null);

  useEffect(() => {
    const signal: ConnectSignal = { type: 'slate-connect-result', ok: !error, message: error };
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel(CONNECT_SIGNAL_CHANNEL);
      bc.postMessage(signal);
      bc.close();
    }
    try {
      localStorage.setItem(CONNECT_SIGNAL_STORAGE_KEY, JSON.stringify(signal));
    } catch {
      /* private-mode storage access can throw — the BroadcastChannel signal still fired */
    }
    if (error) return; // Let the user read the failure; no auto-close.
    window.close();
    // If we're still here shortly after, the browser refused to close the
    // window (e.g. it wasn't opened by this script in this browser's view) —
    // show the manual fallback instead of leaving a silent, unclickable page.
    const t = setTimeout(() => setShowFallback(true), 400);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        aria-hidden
        className={`flex h-12 w-12 items-center justify-center rounded-full ${
          error ? 'bg-destructive/10 text-destructive' : 'bg-primary text-primary-foreground'
        }`}
      >
        {error ? (
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 8v5M12 16h.01M10.3 3.9 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        ) : (
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <div>
        <h1 className="text-xl font-semibold">{error ? m.errorTitle : m.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{error ? m.errorBody : m.body}</p>
      </div>
      {showFallback ? (
        <button
          type="button"
          onClick={() => window.close()}
          className="inline-flex min-h-[44px] items-center rounded-md border border-border px-4 py-2.5 text-sm transition-colors hover:border-primary"
        >
          {m.close}
        </button>
      ) : null}
    </main>
  );
}
