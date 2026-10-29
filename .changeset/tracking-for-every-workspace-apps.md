---
"@slate/web": minor
"@slate/api": minor
---

Tracking and pixels open to every workspace, with no allowlist, for the tags that load only vendor code: Meta Pixel and PostHog. Google Tag Manager, Google Analytics 4 (new) and HubSpot can run code set up in the host's own account on the dashboard's origin, so they load only for workspaces in `EVENT_TRACKING_ACCOUNTS` (unset = nobody): setting or changing one needs it, clearing one does not, and every public read drops only those three when a workspace is not listed. `/v1/me` answers `eventTrackingHostScriptsEnabled` (and the same value as `eventTrackingEnabled`, its earlier name).

The host's PostHog project can no longer run code on the booking page: its events go only to PostHog's US or EU cloud, and the instance loads nothing from the project (remote config, flags, toolbar, surveys, product tours, chat, site apps and web experiments all off) and keeps its ids in memory. posthog-js is pinned (`POSTHOG_JS_VERSION`, 1.441.0) for every PostHog instance on the page, dCal's own included, so those switches are the ones checked. Meta's automatic events, which read the booking form, are off; the pixel still gets one PageView. GA4 runs on a data layer of its own, so a GTM container on the same page never hears its events twice.

Every tool hears the booking funnel, not only the booking: a day picked, a time picked and the booking (`booking_date_selected`, `booking_time_selected`, `booking_scheduled` on GTM under `dcal`, on GA4 and on the host's PostHog; `BookingDateSelected`, `BookingTimeSelected` and `Schedule` on Meta), each with the event type's slug, length, personal or team, the picked start and accepted or pending, never anything about the invitee or the booking's ID. An embedded page posts the same steps to the framing page: `dapta-calendars.event_type_viewed`, `.date_selected` and `.time_selected` join `.booking_scheduled`.

The editor shows the section to every owner and admin: Meta and the PostHog key with a US or EU cloud choice, plus GTM, GA4 and HubSpot where the deployment allows them (otherwise a line says why they are not offered, and whatever they hold goes back unchanged). Each field refuses an id not in its vendor's format, beside it.
