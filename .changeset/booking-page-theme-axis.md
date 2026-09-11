---
"@slate/types": minor
"@slate/shared": minor
---

Give the booking page its own theme — a tenth style axis, `theme: 'light' | 'dark'`,
defaulting to **light** (ADR 0004).

The host sets it in the studio beside the other nine appearance axes, and the live
preview moves with it. It is overridable per embed by a `theme` URL parameter (the
tenth, joining the nine that shipped with inline embeds), and it is never influenced
by the host's own admin theme preference. There is no `auto` value: following the
invitee's `prefers-color-scheme` would make the page look different on different
phones and match the host's preview on neither.

**This changes live pages.** The axis is additive with no migration — `booking_page_style`
is `jsonb`, so an absent `theme` reads as the default — which means every page saved
before this ships moves from dark to light the day it lands. That is the intended
outcome rather than a regression, but it is visible and should be announced rather
than discovered.

**Two surfaces stay on the default for now.** Both team routes and `/manage/{uid}`
hold no branding in the data model, so they render light regardless of what the
host chose for their personal page. An invitee can therefore book on a dark event
page and land on a light manage page from the confirmation email. Giving teams
their own branding is a separate piece of work; this is stated so it is not
discovered.

**The document now waits on one profile read.** `<html>` carries the theme, and the
root layout is the only place that can stamp it, so resolving a personal booking
route's canvas moved a `cache()`d profile fetch onto the critical path of the HTML
shell. It is the same fetch the page already made — one per request, not a new
round trip — but an API stall now delays the document rather than only the page
body. The reasoning is in `apps/web/lib/theme.server.ts`.

`@slate/shared` also gains `theme` on `PublicBranding` and `defaultBranding()`, so
a consumer of that type sees all ten axes. `ThemeAxes` deliberately stays at nine:
a studio preset describes a silhouette and must not move a host between canvases.

`@slate/shared`'s token sheet gains a subtree-capable light theme: the light block
was scoped to `:root`, so paper could only ever be the whole document. A bare
`[data-theme='light']` selector joins it, which is what lets a light booking page
render inside the dark admin — the studio preview is exactly that region. Document-level
behaviour is unchanged.
