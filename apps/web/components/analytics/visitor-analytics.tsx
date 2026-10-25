'use client';

import { useEffect } from 'react';
import { ANALYTICS_PRODUCT, analyticsEventName, type AnalyticsConfig } from '@slate/shared';
import { connectAnalytics } from '@/lib/analytics/connect';
import { clearActiveAnalyticsPort, setActiveAnalyticsPort } from '@/lib/analytics/port';

/** Which public page this is. */
export type BookingPageKind = 'profile' | 'event' | 'team' | 'team_event';

/** Marks a growth link (badge, free-calendar CTA) whose clicks are counted. */
export const CTA_ATTRIBUTE = 'data-analytics-cta';

/**
 * Anonymous product analytics for a PUBLIC booking page. Renders nothing; with
 * analytics off (`config` null, every bare fork) it does nothing at all.
 *
 * What it never does: identify the visitor, create a person profile for them,
 * write anything to their device, record the session, or capture what they
 * type. It sends a handful of hand-written events (the page was viewed, a day
 * and a time were picked, the booking went through, a growth link was clicked)
 * tagged with the page's ACCOUNT, so the host's funnel can be counted without
 * knowing who the visitor is.
 *
 * The account rides as the `account_code` property rather than as an
 * analytics group: grouped events require a person profile per visitor, and
 * a booking page must not create one.
 */
export function VisitorAnalytics({
  config,
  page,
  accountKey,
  embed,
}: {
  config: AnalyticsConfig | null;
  page: BookingPageKind;
  /** The account's immutable short code (`shortCode` on the public payload). */
  accountKey: string | null;
  embed: boolean;
}) {
  const provider = config?.provider ?? null;
  const key = config?.key ?? null;
  const host = config?.host ?? null;
  const errors = config?.errors ?? false;

  useEffect(() => {
    if (!provider || !key || !host) return;
    const port = connectAnalytics({ provider, key, host, errors }, 'visitor');
    if (!port) return;
    setActiveAnalyticsPort(port);
    port.register({
      product: ANALYTICS_PRODUCT,
      surface: 'booking_page',
      account_code: accountKey,
      embed,
    });
    port.capture(analyticsEventName('booking_page_viewed'), { page });

    // One listener for every growth link on the page, so the badge and the CTA
    // stay plain server-rendered anchors. The medium is read off the link's
    // own `utm_medium`, which is what the signup side will see.
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>(`a[${CTA_ATTRIBUTE}]`);
      if (!link) return;
      let medium: string | null = null;
      try {
        medium = new URL(link.href).searchParams.get('utm_medium');
      } catch {
        /* no medium to report */
      }
      port.capture(analyticsEventName('cta_clicked'), { utm_medium: medium, page });
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      clearActiveAnalyticsPort(port);
    };
  }, [provider, key, host, errors, page, accountKey, embed]);

  return null;
}
