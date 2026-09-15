---
'@slate/shared': minor
---

Connect-a-calendar: the explicit check now answers, and the dead manual path is gone.

`connectChecking`, `connectNotSeenYet`, `connectGaveUp` and `connectCheckFailed` join
the connections catalog in both locales.

**Minor, not patch:** six members are REMOVED from the exported `BookingMessages`
interface — `manualTitle`, `manualDesc`, `provider`, `calendarId`, `addConnection`
and `addingConnection` — along with the manual-add form they belonged to. A fork that
maintains its own locale object literal against that interface has to drop those keys
to keep compiling.
