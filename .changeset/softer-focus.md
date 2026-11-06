---
"@slate/shared": patch
"@slate/web": patch
---

A quieter focus indicator across the product. The field focus halo (`--ring`) is a translucent wash of the signal green (35%) instead of a solid band, in both themes; a focused field still turns its edge `--primary`, which is what clears 3:1. The global `:focus-visible` outline is 1.5px instead of 2px, same colour (still 3:1 on every ground, `tokens.spec.ts`). Booking pages keep their own accent ring.
