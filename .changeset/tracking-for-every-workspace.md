---
"@slate/types": minor
"@slate/shared": major
"@slate/config": patch
---

Tracking ids are checked against each vendor's own format, and a new tag joins them. `@slate/types`:
- `eventTrackingSchema` takes `ga4Id` (Google Analytics 4, `G-` plus 4 to 20 letters or digits) and checks every id against its vendor: GTM `GTM-` plus 4 to 12, Meta Pixel and HubSpot digits only, the PostHog key `phc_`. The PostHog host is PostHog's own US or EU cloud and nothing else (`POSTHOG_HOSTS`), because posthog-js loads scripts from whatever host it is given. `normalizeEventTracking` upper-cases GTM and GA4 ids and stores the PostHog host as a bare origin; on read it drops anything the save would refuse, including ids saved under the earlier, looser rules, and drops a PostHog key whose stored host is refused, so its events never go to a cloud the host did not choose.
- `EVENT_TRACKING_HOST_SCRIPT_KEYS` (`gtmId`, `ga4Id`, `hubspotTrackingId`: the tags that can run code set up in the host's own account), `withoutHostScriptTracking` and `hasHostScriptTracking`. `EVENT_TRACKING_KEYS` gains `ga4Id` and lists the keys in the editor's new order.

`@slate/shared` adds the EN and ES copy for GA4, the PostHog cloud choice, one error per vendor format and the note shown when GTM, GA4 and HubSpot are not offered (required `BookingMessages` members, hence major). `@slate/config` only rewords `EVENT_TRACKING_ACCOUNTS`.
