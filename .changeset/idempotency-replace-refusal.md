---
"@slate/db": minor
---

`completeApiIdempotency` takes `replaceRefusal`: write over an open record or a
stored refusal (status 400 and up), never over a stored success, in one
conditional UPDATE.
