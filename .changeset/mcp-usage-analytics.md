---
"@slate/api": patch
---

Every MCP tool call is reported to product analytics as one `$mcp_tool_call`
event in PostHog's MCP analytics vocabulary, like dForms, so both MCPs show up
on the same MCP screens of a shared project, told apart by
`$mcp_server_name: 'dCal'` and `product: 'calendars'`. The event carries the
tool name, error flag and lowercased error code, duration, protocol version,
the client's name, version and user agent, the AI vendor when a header names
it, the server version, `credential_type`, `is_internal` and `staff_access`.
A call acting as a member is sent under the member's email and grouped by its
account; an API key under its public prefix, a sign-in that acts in no account
under its subject, and a call with no credential under one constant id, all
three with no person profile. Never the arguments, the result, an error
message, names, emails, booking ids or the caller's address. Delivery goes
through the analytics outbox; the tool call never waits on it, and with
analytics off nothing is read or enqueued. `AnalyticsEffects.captureRaw` lets
only `$mcp_*` names skip the `calendars_` prefix.
