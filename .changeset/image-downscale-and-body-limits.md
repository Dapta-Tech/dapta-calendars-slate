---
'@slate/types': minor
'@slate/shared': minor
---

Downscale uploaded images in the browser instead of rejecting them over 1MB.

`@slate/types` exports `MAX_INLINE_IMAGE_CHARS` and the request-body ceiling
that makes it reachable, and `brandingSchema.avatarUrl` / `coverUrl` gain the
length cap that `teamInputSchema.logoUrl` already had — they previously had
none at all. `@slate/shared` gains the copy for the new resizing, help and
size-failure states in both locales.
