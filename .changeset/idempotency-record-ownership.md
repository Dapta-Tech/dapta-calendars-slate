---
"@slate/db": minor
---

`claimApiIdempotency` now reports whether the call opened the record
(`inserted`), and `completeApiIdempotency` reports whether it wrote a row
(and takes `onlyOpen` to write only on a record that holds no result yet), so
a caller can act only on its own open record and notice a result that was not
stored instead of losing it silently. Existing callers are unaffected.
