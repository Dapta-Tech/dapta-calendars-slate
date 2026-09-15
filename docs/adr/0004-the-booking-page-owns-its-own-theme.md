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

## Amendment — 2026-09-11 (#162)

Two of the decisions above are reversed by the product owner. They are recorded
here rather than in a superseding ADR because only part of this document
changes: the tenth axis, the studio control, the embed override, the
`bookingCanvasOf` resolver and the ban on inheriting the host's admin
preference all stand exactly as written.

### The default canvas is now `dark`

`theme` still defaults, still has no `auto`, and is still never influenced by
the host's own admin theme. The default value moves from `light` to `dark`.

The original reasoning — that the invitee is a stranger and the category renders
on paper — was not disputed on its merits. It was outweighed: the product is
dark, and the booking page is part of the product.

The fact lives in two independent readers and both moved together:
`bookingPageStyleSchema.theme`'s zod `.default()` in `@slate/types`, and
`DEFAULT_BOOKING_THEME` in `@slate/shared`, which `apps/web/lib/booking-canvas.ts`
re-exports. A split between them parses one canvas and derives the accent
tokens against the other, with no error anywhere — just a wrong-looking page.
`apps/web/lib/booking-canvas.spec.ts` is the only place both are reachable, so
the parity assertion lives there.

Timing was part of the decision. The studio control shipped days earlier
(#109), so almost nothing carries an explicitly saved `theme` yet. Configs with
no stored value went dark → light at that merge and this puts them straight
back; in a month, against real saved values, it would have been a second
visible move instead of an undo.

### The engine no longer alters the host's accent

`clampAccent` mixed the chosen colour 12% toward the canvas's opposite pole,
repeatedly, until it cleared 3:1 against the ground. It does not any more. The
colour renders as chosen. If a host picks something illegible, that is theirs to
fix, and the studio shows them the number rather than overruling them.

Three values that looked like one, and the diff keeps them apart:

| Value | What it is | Outcome |
|---|---|---|
| `clampAccent` | the host's colour as a fill | no longer adjusted |
| `accentInk` / `accentEdge` | the host's colour as link text and as a rim | no longer adjusted — same colour, same rule |
| `onAccent` | the black-or-white label sitting *on top of* the fill | **keeps its floor** |

`onAccent` is not the host's colour. It is a value the engine invents to put on
their colour, and a host who picks dark green never chose black text on dark
green. Measured across the sRGB cube its worst case is about 4.1:1, which is
also why the studio's warning has to measure the canvas and can never be about
the label.

`clampAccent` keeps two other things. Its invalid-hex fallback
(`parseHex(hex) ?? parseHex(DEFAULT_ACCENT)`) stays, because
`apps/web/lib/embed.ts` lets a pasted snippet override `brand_color` from the
URL and a typo there has to degrade rather than break the page. And it keeps its
`canvas` parameter: nothing reads it now, `brandVars` still genuinely needs one
for the hover direction and the wash, and a signature that quietly stopped
asking would be the easiest place for preview and production to drift apart
again.

`accentWasAdjusted` is deleted rather than left returning a constant `false`.

### The studio informs instead of correcting

`adjustedNote` is retired in both locales. The contrast readout stays and is
relabelled to name what it measures — the button LABEL on its fill — and a
non-blocking `lowContrast` warning appears below it when
`accentCanvasContrast` falls under `MIN_ACCENT_CONTRAST` (3:1) against the
ground the page paints on. Two grounds, so both are named; the save is never
blocked.

`accentCanvasContrast` truncates to one decimal rather than rounding to nearest,
and that is a correctness requirement rather than a display preference. The
studio both shows this number and decides on it, and rounding to nearest reports
a true 2.9885:1 as a passing `3` — roughly 4,500 colours per canvas that sit
under the floor and would never warn. Truncating can only understate, so the
number a host reads and the number the warning fires on are one value that never
claims a ratio the colour does not have.

### The accepted cost

This is a deliberate accessibility regression on the one surface strangers use.
A host who picks a low-contrast accent now ships a booking page whose links and
buttons can fail WCAG AA, and nothing stops them. It was raised, and the product
owner chose it: the host owns their brand, and the studio will show them the
number.

Recorded here, in the changeset and in the PR body specifically so that it is
not rediscovered as a bug and "fixed". `packages/shared/src/branding.spec.ts`
carries the same load: its sweep over 24,389 colours was built on the opposite
law and now proves the colour comes back unchanged on both canvases while
`onAccent` still clears its own floor for every one. A test named
*lets an illegible accent through — the accepted cost, asserted* fails if anyone
reinstates the clamp.

### What this does to the consequences above

- "`clampAccent` is no longer meaningful without a canvas" is now false in its
  literal form; the parameter is retained by discipline, not by arithmetic. The
  rule it protects — preview and production must clamp against the same ground —
  survives, because `brandVars` still resolves hover and wash per canvas.
- "Every pre-existing host therefore moves to a light booking page" is undone.
  Pages with no stored `theme` move back to dark, which is where they were
  before #109.
- "Without the bidirectional clamp, 'light booking page' is a promise the
  product cannot keep for any host whose brand colour is dark" is accepted as a
  cost rather than answered. A dark brand colour on a light booking page is now
  the host's to notice, with the warning to notice it by.
