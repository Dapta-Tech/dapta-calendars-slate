# Product analytics

Calendars can report how it is used to an analytics project the **deployment**
owns. It is **off by default**: a fork that sets nothing loads no script,
enqueues nothing and makes no request. Turning it on is described in
[`SELF-HOSTING.md`](SELF-HOSTING.md#product-analytics-optional); this page is
the event catalogue and the privacy model behind it.

## Two audiences, two rules

| Who | Identified? | How |
|---|---|---|
| **Hosts**: people who sign in (dashboard, first-run wizard) | Yes, by **email**, the same id on server and browser events | Server events from the API, plus dashboard pageviews and two clicks from the browser |
| **Visitors**: anyone on a public booking page | **Never** | Anonymous counts tagged with the page's account. No person profile, nothing stored on the device (memory only), no session recording, no autocapture |

What is **never** sent, on any surface: a visitor's name, email, phone or
answers; anything typed into a form; a query string or fragment of any URL; a
paid click id (`gclid`, `fbclid`, reduced to a `has_click_id` flag); a full
referrer URL (reduced to its domain on server events and to its origin on
visitor events). Session recording, autocapture, heatmaps, dead-click and
exception capture are switched off in the browser on every surface.

A visitor's email is read in exactly one place, on the server, to compute two
booleans for `booking_created` (`invitee_is_member`, `invitee_is_internal`); it
is not serialized.

## Naming

- Every event is prefixed **`calendars_`**, applied centrally, never at a call site.
- Every event carries `product: "calendars"`.
- The account group type is **`calendars_account`**, keyed by the account's
  **short code**: the six-character code it was born with, which never changes
  (the public code in a URL can become a vanity slug). Server and host events
  carry the group; visitor events carry the same value as the `account_code`
  property instead, because grouped events would need a person profile per
  visitor.
- `is_internal` marks the operator's own people, from
  `PRODUCT_ANALYTICS_INTERNAL_EMAILS`: on host events it describes the person
  the event is about; on the account group it describes the founder, so an
  operator visiting a customer's workspace never marks it internal.
- Server events carry `$host` (from `PUBLIC_APP_URL`), so they filter by
  deployment the same way browser events do.

## Events

### Server (API, through the outbox)

Emitted where the change is committed, so they are true whatever the client
(dashboard, API key, agent). Delivered by the outbox worker with retry; an
event the vendor refuses is recorded `skipped` once.

| Event | When | Properties |
|---|---|---|
| `calendars_signup_completed` | A login creates a member, or adopts an invite | `role`, `is_first_member`, `from_invite`; sets person `email`, `is_internal`. A first member also sets the account's `is_internal` and `created_at` |
| `calendars_attribution_captured` | The first-touch campaign tags are claimed onto a new account (the existing ten-minute cookie) | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `referrer_domain`, `has_click_id`. The same tags (without the flag) are set on the account |
| `calendars_template_chosen` | The wizard creates the first event type from a template | `template` |
| `calendars_calendar_connected` | A new calendar connection is stored | `provider`, `method` (`connect_flow` or `manual`) |
| `calendars_hours_set` | A schedule is saved with availability rules | `rule_count`, `created` |
| `calendars_event_type_published` | An event type becomes visible on the booking page (created visible, a hidden one made visible, or the wizard's template) | `source` (`dashboard` or `onboarding`), `is_team`, `requires_confirmation` |
| `calendars_branding_changed` | The booking page look or the workspace brand kit changes | `change` (`page_style`, `look_applied`, `brand_kit`, `kit_applied`, `reverted`), `fields` (names of the settings saved, never their values) |
| `calendars_hide_branding_toggled` | The Dapta branding switch changes | `hidden` |
| `calendars_booking_created` | A booking is created (not on an idempotent replay). About the **host** who received it | `channel` (`booking_page`, `host`, `api`), `status`, `is_team`, `invitee_is_member`, `invitee_is_internal` |

### Browser, host (dashboard and wizard only)

| Event | When | Properties |
|---|---|---|
| `$pageview` | Each dashboard navigation | the vendor's own, URLs without query |
| `calendars_template_skipped` | "Skip for now" on the template step | none |
| `calendars_link_copied` | A booking link is copied | none |

A host is identified on the dashboard with `email`, `member_id`, `role` and
`is_internal`, and joins the `calendars_account` group. When a marketing
landing handed over its anonymous id as `?ph_id=`, the middleware parks it in a
ten-minute httpOnly cookie (`slate.ph_id`) beside the campaign cookie, and the
first dashboard or wizard page joins that landing visit to the host, once.
Signing out resets the identity.

### Browser, visitor (public booking pages)

Loaded on the profile, event, team and team event pages. Not loaded on the
manage page or on one-off links, whose URLs carry a token.

| Event | When | Properties |
|---|---|---|
| `calendars_booking_page_viewed` | The page renders | `page` (`profile`, `event`, `team`, `team_event`) |
| `calendars_day_picked` | A day is chosen | `mode` |
| `calendars_slot_picked` | A time is chosen | `mode` |
| `calendars_booking_submitted` | The details form passes validation and is sent | `mode` |
| `calendars_booking_confirmed` | The booking is answered, once per booking | `status` (`accepted` or `pending`), `mode` |
| `calendars_cta_clicked` | The "Made with" badge or the free-calendar call to action is clicked | `utm_medium` read off the link (`badge`, `confirmation`, `profile`), `page` |

Every visitor event also carries `account_code`, `surface: "booking_page"`
and `embed`.

## The seams

- **Contract** (`@slate/shared`, `analytics.ts`): event names, the prefix, the
  group type, config resolution, the internal-email matcher, the landing id
  sanitizer. Vendor-neutral and pure.
- **API port** (`apps/api/src/analytics.provider.ts`): `AnalyticsProvider`,
  with the committed PostHog adapter (one JSON POST per event to `/capture/`,
  no SDK). `AnalyticsEffects` enqueues; the outbox worker delivers.
- **Browser port** (`apps/web/lib/analytics/`): `AnalyticsPort` and `track()`.
  The PostHog adapter installs the vendor's loader stub and loads the library
  from the configured host, so nothing is bundled. Each audience runs in its
  own named instance with its own settings.

To support another vendor, implement both ports and select them in
`createAnalyticsProvider` (API) and `connectAnalytics` (web). Nothing else
names a vendor.
