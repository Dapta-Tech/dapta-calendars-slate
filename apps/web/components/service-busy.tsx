'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '@slate/shared';

/** Automatic retries before the page stops asking on its own and leaves it to the button. */
export const BUSY_AUTO_RETRIES = 3;
/** Never sooner than this, whatever `Retry-After` said, and never later than the cap. */
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30_000;

export interface ServiceBusyCopy {
  busyTitle: string;
  busyBody: string;
  busyRetrying: string;
  busyStill: string;
  tryAgain: string;
}

/**
 * The page could not be served because the scheduling service was busy (a
 * 429). Says so honestly, waits out the service's `Retry-After` and asks again
 * on its own (a bounded number of times, a little jittered), and keeps a "Try
 * again" button that asks at once. Asking again re-renders the page on the
 * server; when the service answers, this notice is replaced by the page.
 *
 * The attempt count survives those re-renders: the server renders this same
 * component in the same place while the service stays busy, so React keeps its
 * state and the retries stay bounded instead of starting over each time.
 */
export function ServiceBusy({
  copy,
  retryAfterMs,
  onRetry,
}: {
  copy: ServiceBusyCopy;
  retryAfterMs: number;
  /** For tests; defaults to re-rendering the route. */
  onRetry?: () => void;
}) {
  const router = useRouter();
  const retry = useRef(onRetry ?? (() => router.refresh()));
  const [attempts, setAttempts] = useState(0);
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Schedule the next automatic retry each time the page is (re)rendered busy.
  useEffect(() => {
    if (attempts >= BUSY_AUTO_RETRIES) {
      setDueAt(null);
      return;
    }
    const base = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, retryAfterMs));
    const wait = Math.round(base * (1 + Math.random() * 0.25));
    const at = Date.now() + wait;
    setDueAt(at);
    const fire = setTimeout(() => {
      setAttempts((n) => n + 1);
      retry.current();
    }, wait);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(fire);
      clearInterval(tick);
    };
  }, [attempts, retryAfterMs]);

  const exhausted = attempts >= BUSY_AUTO_RETRIES;
  const seconds = dueAt ? Math.max(1, Math.ceil((dueAt - now) / 1_000)) : null;

  return (
    <section className="bp-card bp-notice" aria-labelledby="busy-title">
      <h1 id="busy-title" className="bp-notice-title">
        {copy.busyTitle}
      </h1>
      <p className="bp-muted">{exhausted ? copy.busyStill : copy.busyBody}</p>
      <p role="status" aria-live="polite" className="bp-muted bp-small">
        {!exhausted && seconds ? t(copy.busyRetrying, { seconds }) : null}
      </p>
      <button type="button" onClick={() => retry.current()} className="bp-btn bp-cta">
        {copy.tryAgain}
      </button>
    </section>
  );
}
