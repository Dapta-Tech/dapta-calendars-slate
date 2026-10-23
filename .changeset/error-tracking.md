---
'@slate/shared': minor
'@slate/config': minor
---

Error tracking on the product analytics project, on whenever analytics is on and off with it.

- `@slate/shared`: `error-reporting.ts`, vendor-neutral: `scrubErrorText` and `SCRUB_RULES` (emails, phone numbers, long digit runs, bearer and basic credentials, JWTs, prefixed keys, named secrets, a failed query's parameters, every URL's query, fragment and credentials), `scrubFrameFilename`, `parseStackFrames`, `describeError`, `createErrorReporter` (a bounded in-memory queue of 100, 60 sends a minute, the same error counted once a minute with `count`; no database in its path), `reportableRequestId`, `reportableHost` and `hostOfUrl` (a public host only, never a cluster, private or loopback address), `REPORTABLE_MESSAGE` (what an error whose message quotes an upstream body may report instead), `exceptionEvent` and `sendAnalyticsEvent` (the one POST helper, behind `AnalyticsConfig`). `AnalyticsConfig` gains `errors`, from `PRODUCT_ANALYTICS_ERRORS` via `analyticsErrorsEnabled` (on unless `off`; any other value reads as `off`) and `analyticsErrorsSettingUnknown`.
- `@slate/config`: `PRODUCT_ANALYTICS_ERRORS`, a plain optional string read case-insensitively, so a mistyped value turns error tracking off and never stops the API booting.
