---
"@slate/shared": minor
---

Make the branding engine theme-aware (ADR 0004, reskin slice B1).

**Breaking:** `clampAccent(hex)` is now `clampAccent(hex, canvas)`, and the
canvas is required. A clamp is only meaningful against a ground, so every caller
has to say which one it is clamping for — the compiler now makes that
unavoidable, and the studio preview and the public render agreeing on it is what
keeps "preview == production" true. `accentVars`, `accentWasAdjusted`,
`accentLabelContrast` and `brandingStyleVars` take the same second argument.

The clamp is bidirectional: it lightens toward white on a dark ground and
darkens toward black on a light one. The one-directional version lightened in
both cases, so a host's navy came out of the engine as a washed pale blue and
then disappeared on a light booking page.

New exports: `BrandCanvas` (`'dark' | 'light'` — the same union the stored
`theme` axis will carry), `CANVAS_HEX`, `accentInk` (the accent as letters,
4.5:1), `accentEdge` (the accent as rim and focus outline, 3:1), `brandVars`
— the one block a branded surface emits, covering `--primary`,
`--primary-foreground`, `--primary-ink`, `--primary-edge` and `--ring` on top of
the `--accent*` vars — and `contrastRatioExact`, the unrounded ratio.

Emitting the product tokens is the point. `globals.css` re-points `text-primary`
at `--primary-ink` and rims every accent fill with `--primary-edge`, both of
which resolve from the PRODUCT palette unless a branded surface overrides them,
so a page that set only `--primary` painted the host's links and rims in our
lime.

`--accent-hover` now travels the same way the clamp does. Mixing toward white on
a light canvas faded the hover state toward the page behind it.

**Bug fix: the clamp measured a colour it did not ship.** The step loop tested
the running float and only then rounded to 8-bit channels, so a value could
clear the floor by 2e-7 and lose up to half a channel step on the way out. Three
consequences, all now gone: `clampAccent` returned fills at 2.98:1 against a
documented 3:1 floor and `accentInk` returned letters at 4.49:1 against 4.5:1;
the clamp was not idempotent, so re-clamping moved a colour again; and because
the studio saved a clamped accent that the public page then clamped a second
time, the two surfaces rendered different colours — the preview-vs-production
split ADR 0004 exists to prevent. The loop now measures the quantized candidate.

**What changes on a live page.** `--primary-ink` moves for saturated mid-tones
that were sitting at the 3:1 fill floor instead of AA: a `#c2261c` host's links
go from 4.0:1 to 5.7:1 on the page and 3.8:1 to 5.4:1 on a card; `#2563eb` from
3.8:1 to 5.7:1. Light accents such as the DS lime are unchanged at 14.2:1.
Separately, the dark canvas is **not** byte-identical to slice F: for the
accents that fell in the rounding band, `--primary`, `--primary-edge` and
`--ring` also move, because slice F was shipping them below the floor it
documented. Swept over the whole sRGB cube, that is 38,980 of 16,777,216
colours — 0.23% — on dark, and 0.44% on light. Nothing renders on a light
canvas yet; the `theme` axis is slice B2.
