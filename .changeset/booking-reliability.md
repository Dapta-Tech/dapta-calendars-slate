---
'@slate/db': minor
'@slate/config': minor
'@slate/shared': minor
---

Booking reliability: a slow or failing calendar no longer takes the booking page down, a slow webhook no longer delays anything else, and a busy service reads as busy.

- `@slate/db`: the outbox claims rows with a LEASE. New nullable `outbox.lease_until`, `outbox.lease_token` and `outbox.first_failed_at` (migrations `postgres/0026`, `sqlite/0025`, additive). `claimDueOutbox(db, now, limit, opts)` now leases what it returns (`opts`: `kinds`, `excludeKinds`, `leaseMs`, `token`, `onePerDestination`), so several workers or replicas never deliver one row at once; `markOutboxDone/Retry/Skipped/Failed` take the claim's `leaseToken`, answer whether they wrote, and release the lease; `renewOutboxLease` keeps a slow delivery's claim. `markOutboxRetry` takes `delayMs` and remembers the first failure; `outboxRetriesExhausted` (attempt budget AND retry horizon), `retryDelayMs` (jittered) and `MAX_BACKOFF_MS` are new, and `backoffMs` now caps at 15 min. `deliverWebhookEvent` sends `X-Slate-Delivery` (stable across retries) when given `deliveryId`; `recordWebhookGaveUp` writes the delivery log's last line for an event that will not be delivered. `confirmBooking` takes an optional `CalendarProvider` and then checks the host's calendar for the booking's time first (`SLOT_TAKEN` when busy, `CALENDAR_UNAVAILABLE` when unreadable). `loadBookingHostConnectionRefs` lists every connection of a booking's hosts.
- `@slate/config`: optional `CALENDAR_BUSY_CACHE_TTL_MS`, `CALENDAR_BUSY_CACHE_MAX_STALE_MS`, `CALENDAR_BUSY_CACHE_MAX_ENTRIES`, `CALENDAR_BUSY_READ_TIMEOUT_MS`, `OUTBOX_RETRY_HORIZON_MS`, `OUTBOX_CONCURRENCY`, `OUTBOX_LEASE_MS`, all with defaults.
- `@slate/shared`: a `trouble` block in both catalogs (the busy notice, hold and booking failures, the manage page's outcomes, the public error boundaries), and plainer copy for a calendar that cannot be read.
