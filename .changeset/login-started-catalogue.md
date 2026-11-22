---
'@slate/shared': major
---

The event catalogue gains `WEB_SERVER_ANALYTICS_EVENTS` (`login_started`), the events the web server sends itself. Major: `AnalyticsEvent` gains a member, so an exhaustive `Record<AnalyticsEvent, ...>` must add `login_started`.
