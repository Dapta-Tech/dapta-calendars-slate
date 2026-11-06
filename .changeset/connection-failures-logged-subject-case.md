---
"@slate/api": patch
---

Calendar connection failures that used to be silent are logged, and a connect
no longer depends on how the address was typed.

- A failed health check, a failed account-email lookup (on connect and on the
  connections page's backfill) and a discovery subject the backend refuses now
  each log a warning with the operation and the status, never the connection
  ref, the subject or the backend's response body. Before, these only reached
  the stored health of each connection or nothing at all: an Outlook integration
  that answered 404 to every call stayed invisible for weeks (BUGS-2734).
- A connect starts under the lower-case address (`connectSubject`). Subjects
  are case-sensitive on the calendar backend, so "Jose@x.com" and
  "jose@x.com" were two identities and a connect typed with a capital never
  saw the account the person already had. Discovery asks both the address as
  typed and its lower-case form, so accounts connected before this change are
  still found.
