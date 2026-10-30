---
"@slate/api": patch
---

MCP output schemas stay open to fields added later, so a session opened before
a deploy keeps working after it. A client checks each result against the output
schema it listed when the session began; every output object was closed
(`additionalProperties: false`), so adding one field (the campaign under
`invitee_supplied` in #317) made every `get_booking` call from an older session
fail with "Structured content does not match the tool's output schema". Every
output object of every tool is now a `z.looseObject`; inputs are unchanged.
New `mcp.output-schema.spec.ts`: no tool lists a closed output object, and a
session that listed the tools before the server learned new fields (at the
root, in `booking`, in `invitee_supplied` and on an attendee) still reads
`get_booking`.
