---
"@slate/api": patch
---

MCP and OAuth fixes from the release review (#227):

- Revoking a refresh token (RFC 7009) now revokes its whole connection in the
  adapter itself, so a sibling issued in the retry-grace window cannot outlive it.
- `trimSlash` is a linear loop instead of `/\/+$/`, which was quadratic on a long run
  of slashes in caller-controlled values (`Origin`, `resource`, CIMD paths). The MCP
  door reuses it.
- `untrusted()` drops every leftover `<` and `>` after stripping tags, so invitee text
  can never carry an unclosed `<script`.
- `book_meeting` called with an API key or OAuth token records the booking as the
  `api` channel in product analytics (keyless calls stay `booking_page`), through a
  new analytics-only `analyticsChannel` context field that leaves the duplicate-booking
  guard unchanged.
