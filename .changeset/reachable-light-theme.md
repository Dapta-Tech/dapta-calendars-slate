---
"@slate/shared": patch
---

Each theme block in `tokens.css` now declares `color-scheme`, so light mode is
honest rather than merely painted.

`color-scheme` is the one part of a theme no token can carry: it is what the
browser reads to paint the chrome it owns — `<select>` popups, the internals of
`<input type="date">`, autofill backgrounds, the default scrollbar on any region
the themed-scrollbar rules do not reach, and the canvas behind an overscroll
bounce. Without it a light page still renders all of that dark. It lives in the
sheet rather than in the app shell because the sheet is what a self-hoster
imports, and a consumer stamping `data-theme` should get the whole theme.

`tokens.spec.ts` asserts it per block. The existing light / `prefers-color-scheme`
parity check reads custom properties only, so a `color-scheme` landing in one
light block and missing from the other would otherwise have passed every test in
the file.

The admin catalog gains `admin.common.theme` (`toLight` / `toDark`) in `en` and
`es` — the labels on the new product theme switch.
