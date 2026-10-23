'use client';

import { useEffect } from 'react';
import { ANALYTICS_GROUP_TYPE, ANALYTICS_PRODUCT, type AnalyticsConfig } from '@slate/shared';
import { connectAnalytics } from '@/lib/analytics/connect';
import {
  clearActiveAnalyticsPort,
  setActiveAnalyticsPort,
  type AnalyticsPort,
  type HostAnalyticsIdentity,
} from '@/lib/analytics/port';

/**
 * Product analytics for the signed-in host: the dashboard and the onboarding
 * wizard only. Renders nothing; with analytics off (`config` null, every bare
 * fork) it does nothing at all, not even load a script.
 *
 * Identifies by EMAIL, the identifier the API's server events use too, so a
 * host is one person across both halves (and across a platform's products
 * that share the analytics project).
 */
export function HostAnalytics({
  config,
  identity,
}: {
  config: AnalyticsConfig | null;
  identity: HostAnalyticsIdentity | null;
}) {
  const provider = config?.provider ?? null;
  const key = config?.key ?? null;
  const host = config?.host ?? null;
  const errors = config?.errors ?? false;
  const email = identity?.email ?? null;
  const memberId = identity?.memberId ?? null;
  const accountKey = identity?.accountKey ?? null;
  const role = identity?.role ?? null;
  const isInternal = identity?.isInternal ?? false;
  const landingId = identity?.landingId ?? null;

  // Re-runs on a workspace switch: the account is a super property and the
  // group, so it has to follow the host into the workspace they are now in.
  // Depends on values, never on the objects, which every render re-creates.
  useEffect(() => {
    if (!provider || !key || !host || !email || !memberId || !accountKey || !role) return;
    const port = connectAnalytics({ provider, key, host, errors }, 'host');
    if (!port) return;
    setActiveAnalyticsPort(port);
    port.identify(email, { email, member_id: memberId, role, is_internal: isInternal });
    // Joined to the person by name: the vendor replays a queued alias before
    // the identify above, so leaving it to the current id would join the
    // landing visit to this browser's anonymous id instead.
    if (landingId) aliasOnce(port, landingId, email);
    port.register({
      product: ANALYTICS_PRODUCT,
      surface: 'dashboard',
      account_code: accountKey,
      is_internal: isInternal,
    });
    // The account's own facts (founder, signup source) are set by the API. The
    // browser only joins the group: an operator visiting a customer's
    // workspace must not stamp it with their own `is_internal`.
    port.group(ANALYTICS_GROUP_TYPE, accountKey);
    return () => clearActiveAnalyticsPort(port);
  }, [provider, key, host, errors, email, memberId, accountKey, role, isInternal, landingId]);

  return null;
}

/**
 * Join the landing visit to the person once per landing id per browser. The
 * cookie carrying the id lives ten minutes and cannot be deleted from a
 * Server Component, so every render inside that window would send the merge
 * again without this latch. Blocked storage aliases anyway: the vendor drops a
 * repeated merge, and a join that never happens is the only real loss.
 */
function aliasOnce(port: AnalyticsPort, landingId: string, email: string): void {
  try {
    const latch = `calendars_ph_alias:${landingId}`;
    if (window.localStorage.getItem(latch)) return;
    window.localStorage.setItem(latch, '1');
  } catch {
    /* private mode: alias anyway */
  }
  port.alias(landingId, email);
}
