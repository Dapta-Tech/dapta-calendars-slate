---
"@slate/db": minor
"@slate/types": minor
---

Scope booking idempotency keys to their account. The replay lookup now filters
on the booking's account, and the stored key is namespaced by account so the
column's global uniqueness cannot be claimed across tenants. `createBookingSchema`
no longer carries `idempotencyKey`: the unauthenticated booking payload cannot
set one, and the authenticated surfaces pass it to the booking service as
caller-supplied context instead.

Ships a data-only migration in both dialects that namespaces keys already
stored, so retries against a key from before the upgrade keep replaying and no
pre-existing key stays reserved across tenants. No column, index or constraint
changes.
