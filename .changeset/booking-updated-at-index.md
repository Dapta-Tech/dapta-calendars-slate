---
"@slate/db": patch
---

Index `booking (account_id, updated_at)` (`booking_account_updated_idx`, both
dialects) for the MCP `updated_since` change feed, which filters on the
account and `updated_at` with no bound on the start time and otherwise read
every booking of the account on each poll. Plain `CREATE INDEX IF NOT EXISTS`
with `lock_timeout` 3 s and `statement_timeout` 15 s on Postgres; on a large
booking table, create it `CONCURRENTLY` by hand first and the migration is a
no-op.
