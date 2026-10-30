---
'@slate/types': patch
---

`normalizeBookingUtm` also drops a value with an invisible formatting character (zero-width marks, bidi embeddings, overrides and isolates, the byte-order mark), so a campaign such as `‮elgoog` can never display as another one.
