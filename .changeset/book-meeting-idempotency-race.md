---
"@slate/api": patch
---

MCP `book_meeting`: two calls with the same `idempotency_key` running at once
(a retry after a timeout, a client that sends twice) can no longer leave the key
answering `SLOT_TAKEN` for a booking that exists. A booking made under the key
always answers, ahead of a stored refusal; a refused call looks for its twin's
booking first; a refusal is stored only while the record holds no result; a
success replaces an open record or a stored refusal in one conditional update
and never a stored success, which is replayed. A call whose booking the core
answers as a duplicate now reports `replayed: true`, and `book_team_meeting` on
a team page says when nothing was sent again.
