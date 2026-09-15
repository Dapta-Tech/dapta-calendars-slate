---
'@slate/shared': minor
'@slate/types': minor
'@slate/db': minor
'@slate/config': minor
---

Growth attribution, an explicit parameter allowlist, and the contact sync outbox

`@slate/shared` gains `parseAttribution`, the one definition of which inbound
campaign parameters may ever be recorded: exactly seven keys, normalized, with
the referrer read from the request header and only when cross-origin. Organic
traffic yields nothing rather than a synthetic `direct`. `ATTRIBUTION_COOKIE`
and `ATTRIBUTION_WINDOW_MS` ship alongside it, so the parking cookie's lifetime
and the account-age window the claim enforces are the same constant.

`@slate/db` gains `claimAttribution`, which stamps that blob onto an account
**write-once** and only inside the ten-minute window, reporting the true winner
from an affected-row count on both dialects. It carries no policy of its own —
the caller passes an absolute cutoff — so the package needs no dependency on
`@slate/shared`. Two nullable columns on `account`, with a numbered additive
migration in both dialects and deliberately **no backfill**: `NULL` is the
truthful state for every account that predates it. `OutboxKind` gains
`dapta_sync` and `iam_onboarding`, which is a type-level change only.

`@slate/types` gains the `entry_type` vocabulary and a closed schema for the
attribution claim body, so an unknown key is rejected at the boundary rather
than stored permanently.

`@slate/config` gains the optional `DAPTA_SYNC_*` destination. Unset — the
default, and the only sensible value for a fork — nothing is ever sent: the rows
are enqueued and the worker records them as skipped with a reason.
