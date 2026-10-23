---
'@slate/api': minor
'@slate/web': minor
---

Error tracking on the product analytics project, on whenever analytics is on (`PRODUCT_ANALYTICS_ERRORS=off` turns it off alone), scrubbed before it leaves, with `product`, `surface` and a public `$host` on every event.

- `@slate/api`: a global exception filter reports every 5xx and anything unhandled (never a handled 4xx), with the route template, method, status, request id, account code and `is_internal`; the v2 filter reports its own. Crashes (an uncaught exception, an unhandled rejection) are reported before the process exits as Node would. Reports go through `AnalyticsProvider.captureException` (optional on the port; PostHog: an `$exception` POST to `/capture/`, 3 s timeout), from memory, never the outbox. Stack traces name TypeScript lines (`process.setSourceMapsEnabled`).
- `@slate/web`: `onRequestError` reports every server error (render, route, action, middleware) with the route template, method, status, request id and digest. In the browser, `AnalyticsPort.captureError`; uncaught errors and unhandled rejections are captured on the dashboard and on booking pages (scrubbed, visitors anonymous and allowlisted), and every error boundary reports what it shows, a new `global-error.tsx` included. Errors the server already reported are not sent again from the browser. `PRODUCT_ANALYTICS_SOURCEMAPS=1` at build time emits browser source maps for a deployment to upload through the Dockerfile's `sourcemaps_upload` build secret; every map is deleted before the image is assembled.
