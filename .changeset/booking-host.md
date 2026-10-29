---
"@slate/config": minor
"@slate/types": minor
---

`PUBLIC_BOOKING_URL` (optional, blank = unset): where public booking pages live when they have a host of their own, apart from `PUBLIC_APP_URL`. Unset, or equal to `PUBLIC_APP_URL`, changes nothing. `@slate/types` adds `trackingHostScriptsOrigin` (optional) on the public profile and team profile event types and on the availability response's event type: the only origin a page may start Google Tag Manager, Google Analytics and HubSpot on when they came through because booking pages have a host of their own.
