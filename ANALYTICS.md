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
paid click id (`gclid`, `fbclid`, ...; reduced to a `has_click_id` flag on the
server's `attribution_captured`); a full referrer URL (reduced to its domain on
server events and to its origin on visitor events). Session recording,
autocapture, heatmaps, dead-click and exception capture, surveys and remote
configuration are switched off in the browser on every surface.

How the browser half holds that, whatever the vendor library adds on its own
(it adds more than one would guess: the session's full entry URL and entry
referrer, every campaign tag on the page's URL, copies of both on the person):

- **Visitor events keep an allowlist** of properties and drop everything else:
  device and session basics the vendor needs to accept and count an event, the
  page with its query cut, the referring domain, and this app's own properties.
  A future vendor release that starts sending something new sends it nowhere.
- **Host events** drop every campaign tag, click id and search keyword (the
  signup source is the API's, claimed write-once), and the library collects
  no campaign tags of its own.
- **Every URL** left in any property, on either audience, loses its query and
  fragment.
- This is tested against the real library (`apps/web/lib/analytics/posthog.vendor.spec.ts`,
  the pinned `posthog-js` devDependency) and end to end in the browser suite,
  whose stand-in host serves that same library.

Two things the vendor sees that no property controls: the client's IP address
(which a vendor typically turns into a location) and the user agent, both
carried by the HTTP request itself. If your policy calls for it, turn on your
analytics project's own "discard client IP" setting. The vendor library also
drops traffic it recognizes as automated (`navigator.webdriver`, a headless
browser brand), so bots never reach the funnel.

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
(dashboard, API key, agent). Delivered by the outbox worker: a 3 second
timeout and at most 3 attempts, so a slow vendor never holds booking mail for
long; an event the vendor refuses is recorded `skipped` once. Delivered rows
stay in the `outbox` table like every other kind, host email included, until
the deployment prunes it.

| Event | When | Properties |
|---|---|---|
| `calendars_signup_completed` | A login creates a member, or adopts an invite | `role`, `is_first_member`, `from_invite`; sets person `email`, `is_internal`. A first member also sets the account's `is_internal` and `created_at` |
| `calendars_attribution_captured` | The first-touch campaign tags are claimed onto a new account (the existing ten-minute cookie) | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `referrer_domain`, `has_click_id`, and `utm_withheld: true` when a tag was withheld. The same tags are set on the account, with `utm_withheld` too (without `has_click_id`). A tag that is not a plain label is withheld, never repaired (a value encoded once too many is decoded and checked again, and the decoded label is what is sent): only letters, marks, digits, the space, currency signs, emoji, dashes, typographic quotes, brackets and a short list of punctuation pass (an allowlist, checked after Unicode folding), and an invisible character (outside an emoji), an address or handle, a URL, path or IP address, a colon not followed by a space, an HTML entity, a phone number (led by `+`, in short digit blocks, or in a national format such as `300 1234567`), or an encoding left twice are refused. An unbroken run of digits without `+` is kept (it cannot be told from a campaign id, so a phone whose `+` was not URL-encoded passes), and so are date-coded names (`launch_20261018_01`), slashed dates and joined ids; a name made mostly of short numbers reads as a phone and is withheld. The exact rules live in `analyticsCampaignValue` (`@slate/shared`) |
| `calendars_template_chosen` | The wizard creates the first event type from a template | `template` |
| `calendars_calendar_connected` | A new calendar connection is stored | `provider`, `method` (`connect_flow` or `manual`) |
| `calendars_hours_set` | A schedule is created with availability rules, or saved with rules that changed (a rename is not) | `rule_count`, `created` |
| `calendars_event_type_published` | An event type becomes visible on the booking page (created visible, a hidden one made visible, or the wizard's template) | `source` (`dashboard` or `onboarding`), `is_team`, `requires_confirmation` |
| `calendars_branding_changed` | The booking page look or the workspace brand kit changes | `change` (`page_style`, `look_applied`, `brand_kit`, `kit_applied`, `reverted`), `fields` (names of the settings saved, never their values) |
| `calendars_hide_branding_toggled` | The Dapta branding switch changes (a save that keeps it is not) | `hidden` |
| `calendars_booking_created` | A booking is created (not on an idempotent replay, nor a seat taken on an existing group booking). About the **host** who received it | `channel` (`booking_page`, `host`, `api`), `status`, `is_team`, `invitee_is_member`, `invitee_is_internal` |

### Browser, host (dashboard and wizard only)

| Event | When | Properties |
|---|---|---|
| `$pageview` | Each dashboard navigation | the vendor's own, URLs without query |
| `calendars_template_skipped` | "Skip for now" on the template step | none |
| `calendars_link_copied` | A booking link is copied | `link` (`page`, `event_type`, `one_off`) |

A host is identified on the dashboard with `email`, `member_id`, `role` and
`is_internal`, and joins the `calendars_account` group. When a marketing
landing handed over its anonymous id as `?ph_id=` on one of the product's own
entry points (`/`, `/login`, `/onboarding`, `/admin`), the middleware parks it
in a ten-minute httpOnly cookie (`slate.ph_id`) beside the campaign cookie, and
the first dashboard or wizard page joins that landing visit to the host, once.
A booking page never parks it. Signing out resets the identity.

### Browser, visitor (public booking pages)

Loaded on the profile, event, team and team event pages. Not loaded on the
manage page or on one-off links, whose URLs carry a token.

| Event | When | Properties |
|---|---|---|
| `calendars_booking_page_viewed` | The page renders | `page` (`profile`, `event`, `team`, `team_event`) |
| `calendars_day_picked` | A day becomes the visitor's, once per day: a click, the "next day" button, or a time picked on the day the page opened on | `mode`, `preselected` (true when the day was not clicked: the opening day, or one reached with the arrow keys) |
| `calendars_slot_picked` | A time is chosen | `mode` |
| `calendars_booking_submitted` | The details form passes validation and is sent | `mode` |
| `calendars_booking_confirmed` | The booking is answered, once per booking | `status` (`accepted` or `pending`), `mode` |
| `calendars_cta_clicked` | The "Made with" badge or the free-calendar call to action is clicked | `utm_medium` read off the link (`badge`, `confirmation`, `profile`), `page` |

Every visitor event also carries `account_code`, `surface: "booking_page"`
and `embed`.

## The seams

- **Contract** (`@slate/shared`, `analytics.ts`): event names, the prefix, the
  group type, config resolution (a read credential such as a `phx_` personal
  key is refused, since the key is published to every page), the
  internal-email matcher, the landing id sanitizer. Vendor-neutral and pure.
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
