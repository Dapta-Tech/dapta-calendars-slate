# The booking page owns its own theme, and the branding engine is theme-aware

## Context

The reskin (#70) brings Calendars to the Dapta Forms design language, and that
language is **dark-first**: a blue-cooled console palette, lit by exactly two
saturated colors. The pilot ships real light-mode support with a toggle, so the
admin has a theme and a host can change it.

The public booking page is not the admin. Its viewer is the **invitee** — a lead
belonging to the host's business, who never signed up for Dapta, never chose a
theme, and will never see this product again. Every comparable booking page in
the market renders on paper.

So the question is what theme the public page takes. Three candidate answers:
inherit the product's (dark, like the admin), inherit the *host's* admin
preference, or own a theme of its own.

Underneath sits a second problem that only appears once light is reachable. The
branding engine (`packages/shared/src/branding.ts`) clamps a host's chosen
accent for contrast against a **hardcoded dark canvas**, in one direction only —
it lightens a color until it clears 3:1 on `#222222`. On paper that clamp is
blind: a dark brand color stays dark and stays illegible. And the Forms
machinery re-points the `text-primary` utility at `--primary-ink` globally,
a token `BrandedShell` does not emit — so porting the token sheet unchanged
would silently turn every branded `text-primary` on the public page back into
the *product's* lime instead of the host's own color.

## Decision

The booking page carries a **tenth style axis**, `theme: 'dark' | 'light'`,
stored alongside the nine that already exist and **defaulting to `light`**. It
is set by the host in the studio, overridable per-embed by URL parameter, and
**never** influenced by the host's own admin theme preference. There is no
`auto` value.

The product default stays **dark**.

The branding engine becomes theme-aware to serve it: `clampAccent` takes the
canvas as a parameter and clamps bidirectionally (lightening on a dark ground,
darkening on a light one), and `BrandedShell` derives and emits
`--primary-ink` and `--primary-edge` **from the host's accent**, not the
product's.

## Why

**The two audiences want opposite things, and neither is wrong.** The host is a
Dapta user looking at a console; dark is the language and they see it everywhere
else in the platform. The invitee is a stranger on a landing page; paper is what
the entire category has taught them a booking page looks like. Forcing one
default on both surfaces makes one of the two audiences wrong on purpose.

**Inheriting the host's admin preference is the trap.** It reads as the
considerate choice and it breaks the engine's central promise: the studio
renders a live preview and that preview *is* production. A host who flips their
dashboard to light and thereby flips what strangers see — without touching the
studio — has been given an invisible control. The public page's appearance must
be something the host set deliberately and can see.

**`auto` fails the same test, one step further out.** Respecting the invitee's
`prefers-color-scheme` means the page looks different on different phones and
matches the host's preview on neither. A host choosing an appearance should get
that appearance.

**The engine changes are not optional polish; they are what makes the axis
true.** Without the bidirectional clamp, "light booking page" is a promise the
product cannot keep for any host whose brand color is dark. Without per-host
ink and edge, the reskin quietly repossesses the accent on the one surface the
host is paying attention to. Both are pure functions over color, so the cost is
arithmetic and unit tests, not architecture.

## Consequences

- `clampAccent` is no longer meaningful without a canvas. Any caller — the
  studio preview, the public render, a future email or embed — must say which
  ground it is clamping against, and the two must agree or preview stops
  matching production.
- The axis is additive with no migration: `booking_page_style` is `jsonb`, so
  an absent `theme` reads as the default. Every pre-existing host therefore
  **moves to a light booking page** the day this ships. That is the intended
  outcome, not a regression, but it is a visible change to live pages and
  should be announced rather than discovered.
- Product chrome and host branding now answer to different rules. The
  two-lights law (lime and red, nothing else saturated) governs what *we* paint;
  a host's accent is theirs, and the studio's presets stay open — including the
  purple that the product itself retired.
- A third theme, or a per-event-type theme, would land on this axis rather than
  beside it. The value is an enum on the style object precisely so it can grow.
