---
"@slate/shared": minor
---

Port the design-system token sheet: the console palette, a four-tier text ladder,
and the accent's three jobs as three tokens.

`tokens.css` is replaced wholesale. `--background` moves from `#222222` to
`#0a0c0e`, `--radius` from 8px to 10px, and `--secondary` stops being a saturated
purple — so every screen consuming this package changes appearance, on the theme
users already see. That is the intended outcome of the reskin, not a regression.

New tokens: `--primary-ink` (the accent as letters), `--primary-edge` (the accent
as lines), `--faint` (a fourth text tier), `--brand-ink` /
`--brand-ink-foreground` (a constant ground for fixed-colour artwork),
`--radius-monitor`, and the `--acc-h/--acc-s/--acc-l` channels the accent is now
composed from. `--input` is no longer the same value as `--border`: a form
control's edge has to clear 3:1 where a decorative hairline does not.

The type scale is pinned end to end. One step changes existing layout rather than
only appearance: `text-lg` moves 18px -> 20px, merging into `text-xl` at its call
sites. That is the near-duplicate step being collapsed on purpose, but it is the
one type change worth announcing.

The light half of the sheet is authored and unit-tested against its own contrast
law (`tokens.spec.ts`, which reads the shipped file), but it is not yet reachable
in the app — the root layout still stamps `dark`.

`branding.ts`: `contrastRatio(a, b)` is now exported. `accentVars` composes
`--accent-wash` against `--background` instead of the undefined `--bg-app`, which
makes a previously invalid declaration paint.
