---
"@slate/api": patch
---

MCP output values from a set stay open to values added later, the second half
of #320. A client checks each result against the output schema it listed when
its session began; the three output enums (an event's `kind` in
`find_available_slots` and `list_event_types`, a team's `scheduling_type` in
`find_team_slots` and `book_team_meeting`) were closed, so a new value would
have failed every such call from an older session, the way a new field did.
They are now `openEnum`: the known values are still listed, and any other
string passes. Inputs keep their closed enums. `mcp.output-schema.spec.ts` now
also fails on a closed value set in any output schema, and checks that a
session that listed the tools before the server learned a new `kind` still
reads `list_event_types`.
