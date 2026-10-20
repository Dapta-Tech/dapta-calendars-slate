---
"@slate/api": patch
---

One `stableStringify` behind every idempotency request hash. The `/v2` booking
create, the `/v2` cancel, reschedule and add-guests calls, and the MCP door each
had their own copy, and only the MCP copy left out a property set to `undefined`.
They now share `apps/api/src/stable-stringify.ts`, the MCP variant: the MCP door
does pass `undefined` (`book_meeting` with no hold, confirm or decline with no
reason), so the other variant would have changed its hashes. No stored hash
changes: no `/v2` caller passes an `undefined` property (a JSON body has none,
the schemas leave an absent optional field out, and the MCP tools that call the
`/v2` services add an optional argument only when it is set), which a new spec
checks by driving every caller through the real API. A golden table pins the
output to the replaced copies, so a later change that would invalidate stored
hashes fails CI.
