---
'@slate/shared': minor
'@slate/db': minor
---

The admin wears the dForms language, and the booking page does not move.

- **Tokens** (`@slate/shared`): `tokens.css` is rewritten around paper, ink and
  one Signal Green (`--signal`, rationed to a switch that is on, progress, a
  confirmed booking and focus), with red for destructive and Warning Amber
  (`--warning`) as the one data channel. `--primary` is ink on paper and paper
  on ink. `--sidebar` and `--panel` are the work grounds. The spacing scale is
  unchanged. The control radius is 8px, on the 4px grid the spacing scale
  obeys.
- **Existing booking pages do not change.** The values the sheet carried before
  are frozen as the BOOKING GROUND (`.bp-ground[data-theme]`), which every
  public route, the studio's preview frame and `<html>` on a public document
  carry. `tokens.spec.ts` pins those values literally, and the public-markup
  snapshots show the only markup change on a booking page is the attribution
  badge drawing the dC mark instead of a PNG.
- **New hosts are born with the new look** (`@slate/shared`, `@slate/db`):
  `withNewHostBranding` writes ink (`#1a1a1c`) and the light canvas into the
  stored branding of a host created from nothing (first sign-in under either
  provider, and an invite). It fills only what the caller left out. An absent
  config still means the dark, lime page, so every host created before this
  keeps theirs. `inviteMember` takes the branding to write as an optional
  argument.
- One typeface: IBM Plex Mono is no longer loaded, and `font-mono` draws the
  sans with tabular figures.
- Icons: a generated `icons.css` (Lucide outlines as CSS masks, class names
  unchanged) replaces the PrimeIcons font.
