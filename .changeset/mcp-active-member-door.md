---
"@slate/api": patch
---

Every MCP tool now refuses a sign-in whose member is missing or no longer
active. A sign-in's access token is verified offline, so a member who was
disabled or removed after connecting kept booking, holding and cancelling until
the token expired. The door now loads the member row on each call and answers
`FORBIDDEN` before any tool runs. API keys have no member and are unaffected.
