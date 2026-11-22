---
'@slate/web': patch
---

The login route records `calendars_login_started` with the hosted screen it opens (`sign-up` or `sign-in`), so drop-off on the hosted sign-up screen can be measured. Sent from the server after the redirect has gone out, never in front of it, filed under the landing's parked analytics id when there is one; nothing is sent with analytics off or for an automated client.
