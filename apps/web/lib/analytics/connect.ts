import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog } from './posthog';
import type { AnalyticsPort, AnalyticsSurface } from './port';

/**
 * The adapter for the configured provider: the one place the browser half
 * picks a vendor. A fork adds one by returning its own `AnalyticsPort` here.
 */
export function connectAnalytics(config: AnalyticsConfig, surface: AnalyticsSurface): AnalyticsPort | null {
  switch (config.provider) {
    case 'posthog':
      return connectPosthog(config, surface);
    default:
      return null;
  }
}
