---
'@slate/shared': minor
'@slate/config': minor
'@slate/db': minor
'@slate/types': minor
---

Product analytics, off by default. With `PRODUCT_ANALYTICS_PROVIDER=posthog` and a project key, the deployment reports its own usage to an analytics project it owns; with nothing set (every bare fork) no script loads, nothing is enqueued and no request is made.

- `@slate/shared`: the vendor-neutral contract in `analytics.ts`: the `calendars_` event names (`SERVER_ANALYTICS_EVENTS`, `BROWSER_ANALYTICS_EVENTS`, `analyticsEventName`), the `calendars_account` group type, `resolveAnalyticsConfig` (off unless a known provider and a key are set; an unusable host is off too), `parseInternalEmailPatterns` / `isInternalEmail`, the landing id hand-off (`LANDING_ID_QUERY_KEY`, `LANDING_ID_COOKIE`, `sanitizeLandingDistinctId`) and `referrerDomain`.
- `@slate/config`: `PRODUCT_ANALYTICS_PROVIDER`, `PRODUCT_ANALYTICS_KEY`, `PRODUCT_ANALYTICS_HOST`, `PRODUCT_ANALYTICS_INTERNAL_EMAILS`, all plain optional strings so a mistyped value turns analytics off and never stops the API booting. The web app reads the same names at request time, so no image rebuild is needed to turn it on.
- `@slate/db`: an `analytics` outbox kind (type only; `outbox.kind` is unconstrained text). Public profile and team payloads carry `account.shortCode`, the account's immutable six-character code, which is the analytics group key on both halves.
- `@slate/types`: `publicProfileSchema` and `teamProfileSchema` accept the optional `account.shortCode`.

Server events go through the outbox and the worker (never inline): signup and its first-touch source, template chosen, calendar connected, hours set, event type published, branding changed, branding switch, and booking created (about the host; the visitor's email only decides two booleans and is never serialized). Browser events: dashboard pageviews, link copied and template skipped for identified hosts; booking page viewed, day picked, time picked, booking sent, booking confirmed and growth link clicked for anonymous visitors, who get no person profile, no storage, no recording and no autocapture. Visitor events keep an allowlist of properties (whatever the vendor library adds on its own goes nowhere); host events drop campaign tags and click ids; every URL loses its query and fragment before it leaves the browser. The vendor's loader contract is installed as module code (no inline script). The public growth links carry a `data-analytics-cta` marker. The browser suite runs the real vendor library (pinned `posthog-js` devDependency) against a local stand-in host.
