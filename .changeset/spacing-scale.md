---
'@slate/shared': minor
---

The token sheet gains a spacing scale.

Role-named tokens on a 4px grid — the content ladder `--sp-tight`, `--sp-inline`,
`--sp-field`, `--sp-card`, `--sp-group`, `--sp-section`, the responsive gutter
pair `--sp-page-x` / `--sp-page-x-wide` with `--sp-page-y`, and the two control
roles `--sp-control-h` (the 44px tap-target floor, R28) and `--sp-control-x`. The
gutter and control roles deliberately reuse values the content ladder already
defines.

They are theme-independent, so they sit once on a bare `:root` above both theme
blocks, and `tokens.spec.ts` asserts that — along with the 4px grid, the ascending
content ladder, and that the set of declared roles is exactly the set the sheet
claims, so a token added later is grid-checked without anyone remembering to list
it.

Behaviour change is limited to one thing: the three hand-written `min-height:
2.75rem` hit-target floors in the web app now read `var(--sp-control-h)`, which is
the same 44px. The sweep that migrates the remaining call sites is the second half
of #147.
