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
export function EventTracking({
  tracking,
  hostScriptsOrigin,
}: {
  tracking: EventTracking | null | undefined;
  /**
   * The booking host's origin when booking pages have one
   * (`bookingPageTracking`, which pages spread in): Google Tag Manager, Google
   * Analytics and HubSpot then start only when this document is on it, so a
   * page still served on the dashboard's origin (an old link, an old embed)
   * never runs them next to a session. Null: no such host, and the API's
   * allowlist alone decides. Required, so a new page cannot forget it.
   */
  hostScriptsOrigin: string | null;
}) {
  const t = resolveTracking(tracking);
  const { gtmId, ga4Id, metaPixelId, posthogKey, posthogHost, hubspotTrackingId } = t;
  useEffect(() => {
    const offOrigin = hostScriptsOrigin !== null && window.location.origin !== hostScriptsOrigin;
    const ids = offOrigin
      ? { gtmId: null, ga4Id: null, metaPixelId, posthogKey, posthogHost, hubspotTrackingId: null }
      : { gtmId, ga4Id, metaPixelId, posthogKey, posthogHost, hubspotTrackingId };
    if (hasAnyTracking(ids)) startTracking(window as TrackingWindow, ids);
  }, [gtmId, ga4Id, metaPixelId, posthogKey, posthogHost, hubspotTrackingId, hostScriptsOrigin]);

  if (!hasAnyTracking(t)) return null;
  return (
    <>
      {/* GTM's no-JavaScript container, only where no booking host is set: the
          server cannot tell which origin the page is served on, and a booking
          page needs JavaScript to book anyway. */}
      {gtmId && hostScriptsOrigin === null ? (
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
