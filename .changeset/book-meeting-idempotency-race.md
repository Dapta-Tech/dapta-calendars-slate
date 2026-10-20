---
"@slate/api": patch
---

MCP `book_meeting`: two calls with the same `idempotency_key` running at once
(a retry after a timeout, a client that sends twice) can no longer leave the key
answering `SLOT_TAKEN` for a booking that exists. A call whose booking step is
refused looks for the booking its twin made under the key first and answers
that; a refusal is stored only by the call that opened the record and only
while it holds no result; a success is stored only on a record without one (a
stored success for the key wins, a stored refusal gives way).
