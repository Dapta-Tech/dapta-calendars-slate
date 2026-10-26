---
"@slate/api": patch
---

The MCP tools read a bare date (`2026-09-06`) as that local day through the
engine's own projection, so a day whose midnight is skipped by a DST change
starts at the transition, where the slots do. Before, in
America/Santiago, the Sunday 2026-09-06 window began at Saturday 23:00 and
`find_available_slots` listed a Saturday 23:00 slot for Sunday while the
Saturday query left it out. Other dates are unchanged.
