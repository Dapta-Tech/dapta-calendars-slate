import type { Instrumentation } from 'next';

/**
 * Runs once when the web server starts. Configuration the server can only
 * half use is reported here, once, rather than on every request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { internalApiSecretWarning } = await import('./lib/internal-secret');
  const warning = internalApiSecretWarning();
  if (warning) console.warn(warning);
  const { analyticsErrorsSettingUnknown } = await import('@slate/shared');
  if (analyticsErrorsSettingUnknown(process.env.PRODUCT_ANALYTICS_ERRORS)) {
    console.warn('PRODUCT_ANALYTICS_ERRORS is neither `on` nor `off`; error tracking is off.');
  }
  // With error tracking on, the server's own stack traces name source lines
  // rather than a line of a bundled chunk, wherever the build left the
  // chunks' maps beside them (the web image ships them when built with
  // PRODUCT_ANALYTICS_SOURCEMAPS=1). Only chunks loaded from here on are
  // mapped, which is every route's: they load on first request. Off, nothing
  // changes for a fork.
  const { errorAnalyticsConfig } = await import('./lib/analytics/config');
  if (errorAnalyticsConfig()) process.setSourceMapsEnabled(true);
}

/**
 * Every error the server captures while answering (a render, a route handler,
 * a server action, the middleware), reported to error tracking when it is on
 * (`lib/analytics/server-errors.ts`): route template, method, status and
 * request id, never a header, a body or the path. Returns at once; the report
 * leaves off the request path.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { reportRequestError } = await import('./lib/analytics/server-errors');
  reportRequestError(error, request, context);
};
