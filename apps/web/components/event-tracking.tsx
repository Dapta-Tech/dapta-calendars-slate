'use client';

import { useEffect } from 'react';
import type { EventTracking } from '@slate/types';
import {
  gtmNoscriptSrc,
  hasAnyTracking,
  metaNoscriptSrc,
  resolveTracking,
  startTracking,
  type TrackingWindow,
} from '@/lib/event-tracking';

/**
 * The host's own tags on one event's booking page (see `lib/event-tracking.ts`).
 * Mounted by the three event pages (personal, team, one-off link) and nowhere
 * else. Renders nothing and starts nothing when the event has no id set.
 *
 * The tags start after hydration, from an effect, so the server render stays
 * the same with or without them; the `<noscript>` fallbacks are the only
 * markup, for the two vendors that have one.
 */
export function EventTracking({ tracking }: { tracking: EventTracking | null | undefined }) {
  const t = resolveTracking(tracking);
  const { gtmId, metaPixelId, posthogKey, posthogHost, hubspotTrackingId } = t;
  useEffect(() => {
    const ids = { gtmId, metaPixelId, posthogKey, posthogHost, hubspotTrackingId };
    if (hasAnyTracking(ids)) startTracking(window as TrackingWindow, ids);
  }, [gtmId, metaPixelId, posthogKey, posthogHost, hubspotTrackingId]);

  if (!hasAnyTracking(t)) return null;
  return (
    <>
      {gtmId ? (
        <noscript data-testid="tracking-gtm-noscript">
          <iframe src={gtmNoscriptSrc(gtmId)} height="0" width="0" className="hidden" title="Google Tag Manager" />
        </noscript>
      ) : null}
      {metaPixelId ? (
        <noscript data-testid="tracking-meta-pixel-noscript">
          <img height="1" width="1" className="hidden" alt="" src={metaNoscriptSrc(metaPixelId)} />
        </noscript>
      ) : null}
    </>
  );
}
