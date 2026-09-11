---
'@slate/types': minor
'@slate/shared': minor
---

Booking pages default to dark, and the branding engine renders a host's accent exactly as picked.

Two reversals of ADR 0004, shipped together because both change how live pages look (#162).

**The default canvas is now `dark`.** `bookingPageStyleSchema.theme` and `DEFAULT_BOOKING_THEME` both move from `light` to `dark`. Any booking page with no explicitly saved `theme` renders dark again, undoing the dark → light move that #109 introduced days earlier.

**The engine stops adjusting the accent.** `clampAccent`, `accentInk` and `accentEdge` return the host's colour unchanged on both canvases; `brandVars` emits it as `--primary`, `--primary-ink`, `--primary-edge` and `--ring`. `clampAccent` keeps its invalid-hex fallback and its `canvas` parameter.

**`onAccent` keeps its floor.** It is the black-or-white label on top of the fill, not the host's colour, so a host who picks dark green does not get black text on dark green.

**New and removed exports.** `accentCanvasContrast` and `MIN_ACCENT_CONTRAST` are added for the studio's non-blocking low-contrast warning. `accentCanvasContrast` truncates to one decimal rather than rounding to nearest, because the studio decides on the same number it displays and a rounded 2.99 would read as a passing 3. `accentWasAdjusted` is removed — it would be constant `false`. The `admin.studio.adjustedNote` message is retired in `en` and `es` and replaced by `lowContrast`; `admin.studio.contrast` is relabelled to name the ground it measures.

This is a deliberate accessibility regression, decided by the product owner with the tradeoff stated: a host who picks a low-contrast accent ships a booking page whose links and buttons can fail WCAG AA. The studio shows the ratio instead of overriding the choice. See the 2026-09-11 amendment in `docs/adr/0004-the-booking-page-owns-its-own-theme.md`.
