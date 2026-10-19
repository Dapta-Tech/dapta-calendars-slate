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
- `untrusted()` strips markup with a one-pass linear scanner instead of a tag regex:
  every `<` that can open a tag goes (an unclosed `<script` included) and no kept `<` is
  ever followed by a tag character, while `<10`, `> 50` and `a < b` survive. Every `](`
  left afterwards is broken apart, so a removed tag cannot glue a markdown image or link
  back together. Hidden Unicode tag characters and variation selectors go, the input is
  cut before any regex, and the length cap never splits an emoji.
- `book_meeting` called with the page's own workspace credential (API key or OAuth
  token) records the booking as the `api` channel in product analytics; keyless calls
  and other workspaces' credentials stay `booking_page`. This uses a new analytics-only
  `analyticsChannel` context field, so the duplicate-booking guard is unchanged.
