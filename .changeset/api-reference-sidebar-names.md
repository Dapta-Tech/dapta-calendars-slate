---
"@slate/api": patch
---

The API reference's sidebar reads as product, not as a build log. The tags are
now REST API (`/v1/machine`), Cal.com-compatible API (`/v2`), Calendar
availability, Booking page (the public `/v1` endpoints) and Health, every
operation sits under one of them, and the summaries are short labels ("Create a
booking", "List event types") with the technical detail moved into each
operation's description. The idempotency examples no longer name an internal
tool. Paths, schemas and operation ids are unchanged.
