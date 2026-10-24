---
"@slate/api": patch
---

An MCP sign-in through the external authorization server that reaches no account yet (never linked, not seen on the web within `OAUTH_LINK_MAX_AGE_DAYS`, or not an active owner or admin anywhere) now connects instead of getting a 403. Chat apps showed that 403 as their own error ("Automatic client registration isn't supported"), never our words. The connection acts nowhere: only the public booking page tools run, under the address's rate limit like an anonymous call, and every other tool answers `NOT_LINKED` with the step to take (open the web app once with that account, then try again). The first call after that visit works with no reconnect.
