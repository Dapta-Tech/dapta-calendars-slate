---
"@slate/api": patch
"@slate/web": patch
---

Product analytics tells where an account comes from, and measures the
dashboard's speed.

- `calendars_signup_completed` carries `entry`: `web` when the request that
  created the member came from the web dashboard, `api` for any other caller
  holding a host token (a platform provisioning its user's account through the
  API, which until now read as a signup that never opened the dashboard). The
  web marks every call it makes to the API with `x-slate-client: web`
  (`hostHeaders` and the login callback's attribution claim, often the first
  call). The header is an analytics label only: nothing is granted on it.
- `calendars_event_type_published` says `source: api` for an event type
  published by another client, instead of `dashboard`.
- The dashboard sends web vitals (LCP, INP, CLS, FCP; network timing off).
  Booking pages still send only this app's own events. The e2e analytics
  stand-in serves the vendor's web vitals extension.
