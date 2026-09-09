---
"@slate/db": patch
"@slate/types": patch
---

Scope booking idempotency keys to their account. The replay lookup now filters
on the booking's account, and the stored key is namespaced by account so the
column's global uniqueness cannot be claimed across tenants. `createBookingSchema`
no longer carries `idempotencyKey`: the unauthenticated booking payload cannot
set one, and the authenticated surfaces pass it to the booking service as
caller-supplied context instead. No migration — the column keeps its shape.
