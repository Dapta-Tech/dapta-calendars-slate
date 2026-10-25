'use client';

import { useEffect } from 'react';
import type { AnalyticsConfig } from '@slate/shared';
import { setErrorAnalyticsConfig } from '@/lib/analytics/port';

/**
 * Hands the deployment's error-tracking settings to the error boundaries.
 * Rendered once, by the root layout, so a boundary can report even when the
 * page it replaced failed before its own analytics loader connected. Renders
 * nothing and loads nothing: an audience is connected only when there is an
 * error to report on a page that belongs to one (see `captureError`).
 *
 * With error tracking off (`config` null: analytics off, or
 * `PRODUCT_ANALYTICS_ERRORS=off`) it does nothing at all.
 */
export function ErrorAnalytics({ config }: { config: AnalyticsConfig | null }) {
  const provider = config?.provider ?? null;
  const key = config?.key ?? null;
  const host = config?.host ?? null;
  const errors = config?.errors ?? false;

  useEffect(() => {
    setErrorAnalyticsConfig(provider && key && host && errors ? { provider, key, host, errors } : null);
  }, [provider, key, host, errors]);

  return null;
}
