---
"@slate/db": patch
---

Round robin in equal distribution picks its host where it writes the booking:
on Postgres under a transaction-scoped advisory lock per event type, on SQLite
inside its IMMEDIATE transaction. The event's loads are read again there, the
hosts too far ahead held back again, and the lightest free host chosen, so
bookings made at the same moment no longer all read the same lightest host and
pile onto it. The choice is made among every free host: a host held back when
the request arrived is picked again once the others have caught up under the
lock. A write that fails for any reason other than an overlap is logged.
