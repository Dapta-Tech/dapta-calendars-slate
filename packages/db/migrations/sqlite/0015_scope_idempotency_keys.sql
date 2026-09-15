-- #104 — namespace already-stored booking idempotency keys by account.
--
-- `booking.idempotency_key` carries a GLOBAL UNIQUE, so a raw key belonged to
-- whichever account wrote it first. The code now stores `<account_id>:<key>`
-- and reads through the same transform; without this backfill the rows written
-- before that deploy would (a) stop replaying, so an automation retrying a
-- stable key re-enters the create path, and (b) keep occupying the raw key for
-- every other tenant forever.
--
-- Data-only: no column, index or constraint changes, so both dialects keep the
-- same shape and nothing is dropped.
--
-- Two guards, and the reason the statement is repeated:
--
--   * NOT LIKE skips rows already namespaced, which is what makes the
--     statement safe to run again.
--   * NOT EXISTS skips a row whose target value is currently held by another
--     row. The UNIQUE is not deferrable, so without it the statement would
--     abort instead of skipping.
--
-- The second guard is what forces the repeat. A holder can itself be a raw row
-- that this same statement is about to move — account C holding the literal
-- `<A>:k` while account A holds `k`. One pass moves C's row and skips A's,
-- which then has a free target; the next pass takes it. Each pass resolves one
-- such level, and the runner applies a file only once, so the passes are
-- written out. Real data has no levels at all: reaching even one means a row
-- whose pre-upgrade key literally began with another account's UUID. A chain
-- deeper than three would leave its last row raw — the pre-fix status quo for
-- that row, never a failed migration.
UPDATE booking
   SET idempotency_key = account_id || ':' || idempotency_key
 WHERE idempotency_key IS NOT NULL
   AND idempotency_key NOT LIKE account_id || ':%'
   AND NOT EXISTS (
     SELECT 1 FROM booking existing
      WHERE existing.idempotency_key = booking.account_id || ':' || booking.idempotency_key
   );

UPDATE booking
   SET idempotency_key = account_id || ':' || idempotency_key
 WHERE idempotency_key IS NOT NULL
   AND idempotency_key NOT LIKE account_id || ':%'
   AND NOT EXISTS (
     SELECT 1 FROM booking existing
      WHERE existing.idempotency_key = booking.account_id || ':' || booking.idempotency_key
   );

UPDATE booking
   SET idempotency_key = account_id || ':' || idempotency_key
 WHERE idempotency_key IS NOT NULL
   AND idempotency_key NOT LIKE account_id || ':%'
   AND NOT EXISTS (
     SELECT 1 FROM booking existing
      WHERE existing.idempotency_key = booking.account_id || ':' || booking.idempotency_key
   );
