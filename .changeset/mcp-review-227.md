---
"@slate/api": patch
---

MCP and OAuth fixes from the release review (#227):

- The OAuth adapter revokes a refresh token's whole connection when the token is
  destroyed (RFC 7009 revocation, or a replay). oidc-provider already revokes the
  grant right after; this is defense in depth that no longer depends on it.
- `trimSlash` is a linear loop instead of `/\/+$/`, which was quadratic on a long run
  of slashes in caller-controlled values (`Origin`, `resource`, CIMD paths). The MCP
  door reuses it.
- `untrusted()` strips markup with a small scanner instead of a tag regex: every `<`
  that can open a tag goes (an unclosed `<script` included), repeated until stable,
  after invisible characters and markdown are removed, while `<10`, `> 50` and `a < b`
  survive. The input is cut before any regex so a huge answer cannot slow it down.
- `book_meeting` called with the page's own workspace credential (API key or OAuth
  token) records the booking as the `api` channel in product analytics; keyless calls
  and other workspaces' credentials stay `booking_page`. This uses a new analytics-only
  `analyticsChannel` context field, so the duplicate-booking guard is unchanged.
