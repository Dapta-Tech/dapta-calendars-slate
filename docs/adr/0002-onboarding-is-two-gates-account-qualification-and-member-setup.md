# Onboarding is two gates: account qualification and member setup

## Context

Calendars needed a first-run onboarding, and Dapta Forms already ships one that
works: a cohort-aware wizard gated by a single API-owned `onboardingRequired`
flag, with its answers stored on the `account` row (`account.onboarding` JSON
plus a write-once `onboarding_completed_at` claim), completing by creating the
account's first form from a server-side template registry.

Copying that shape wholesale was the obvious move, and it is wrong here. The two
products own their primary artifact at different levels. In Forms a form belongs
to the **account**, so one person completing onboarding leaves the whole
workspace with something to show. In Calendars the handle and the event types
belong to the **member**: every host has their own public page. A single
account-level gate would therefore mark the workspace "onboarded" after its
owner finishes, while every host invited afterwards lands with a booking link
that renders an empty page — the precise dead end the onboarding exists to
prevent.

## Decision

Onboarding is **two independent gates**, not one.

- **Qualification** — the commercial question bank (`phone`, `industry`, `crm`,
  `lead_volume`, `lead_source`, `use_case`). It describes the workspace and its
  company. Stored on the `account` row and owed by owner/admin only, once per
  account.
- **Setup** — picking a template, which creates that host's first event type. It
  describes one host. Owed by every active member with no event types of their
  own, invited members included.

`GET /v1/me` exposes them as two server-side flags, `onboardingRequired` and
`setupRequired`. One route, `/onboarding`, runs whichever gates apply and skips
the rest, so an invited member lands directly on the template picker.

## Why

The alternative shapes were both worse in a specific, nameable way.

**Everything on the account** (Forms' shape) is the dead end above: invited hosts
never get guided to a working booking link.

**Everything on the member** means every host in a workspace answers the same
commercial questions about the same company. That sends five qualification rows
to the growth CRM for one five-host workspace and pollutes the funnel with
contradictory answers about a single business.

Splitting keeps each answer at the level of the thing it actually describes.
Industry and CRM are facts about a company; a booking page is a fact about a
person. Forms itself gropes toward this with its person-level
`humanHasCompletedOnboarding` check, which exists so someone already qualified in
one workspace is not re-interrogated in another — the same instinct, applied as a
patch rather than a split.

The split also gives the growth funnel a clean rule. Qualification firing means
"a new lead arrived"; setup firing means "a host became bookable". An invited
member reaches the CRM through a separate `entry_type` marker rather than through
the qualification path, so a workspace invitation is never miscounted as campaign
acquisition.

## Consequences

- Two flags, not one, and a reader expecting Forms' single `onboardingRequired`
  should read this ADR rather than "simplify" them back together.
- The "Get bookable" checklist must measure "has at least one published event
  type", not "has a handle". Every member gets an auto-handle at creation, so the
  handle check reports success for a page that renders nothing.
- Qualification is claimed write-once per account; setup has no completion claim
  at all — it is satisfied by the existence of an event type, so a host who
  deletes their last one is guided again rather than stranded.
- A future per-person qualification (an invited host's own use case) is an
  additive member-level column, not a re-fusion of the gates.
