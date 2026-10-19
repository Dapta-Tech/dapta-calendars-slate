import 'server-only';
import {
  isInternalEmail,
  parseInternalEmailPatterns,
  resolveAnalyticsConfig,
  sanitizeLandingDistinctId,
  type AnalyticsConfig,
} from '@slate/shared';
import type { HostAnalyticsIdentity } from './port';

/**
 * The deployment's product-analytics settings, read on the SERVER at request
 * time.
 *
 * Deliberately NOT `NEXT_PUBLIC_*`. Next inlines those as literals at BUILD
 * time, in server bundles too, and one image serves every environment: a key
 * baked into the build would follow the image from dev to production and
 * ignore the per-environment config. These names are read when the page
 * renders (every mount point is a dynamic route) and handed to the browser as
 * props, so the same image can run with analytics on, off, or pointed at a
 * different project, and a fork that sets nothing renders no script at all.
 *
 * The key is a write-only ingestion key, public by design: it reaches the page
 * either way. The internal-email patterns never do (see `isInternalViewer`).
 */
export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig | null {
  return resolveAnalyticsConfig({
    provider: env.PRODUCT_ANALYTICS_PROVIDER,
    key: env.PRODUCT_ANALYTICS_KEY,
    host: env.PRODUCT_ANALYTICS_HOST,
  });
}

/** Is this signed-in host one of the operator's own people? Decided here, on the server. */
export function isInternalViewer(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return isInternalEmail(email, parseInternalEmailPatterns(env.PRODUCT_ANALYTICS_INTERNAL_EMAILS));
}

/**
 * The signed-in host as `HostAnalytics` needs them, from `/v1/me` and the
 * parked landing id. Null without an email: a made-up id would merge
 * unrelated people into one.
 */
export function hostAnalyticsIdentity(
  me: { email: string | null; memberId: string; accountShortCode: string; role: string },
  landingCookie: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HostAnalyticsIdentity | null {
  if (!me.email) return null;
  return {
    email: me.email,
    memberId: me.memberId,
    accountKey: me.accountShortCode,
    role: me.role,
    isInternal: isInternalViewer(me.email, env),
    landingId: sanitizeLandingDistinctId(landingCookie),
  };
}
