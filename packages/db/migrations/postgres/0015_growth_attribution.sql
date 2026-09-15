-- Additive (SAFE): O2 growth attribution on the account (#94, decided at #65).
-- Two nullable columns — `attribution` holds the 7-key allowlist blob captured
-- at the front door, `attribution_claimed_at` is the write-once claim. Pure
-- additive DDL: ADD COLUMN of a nullable column takes a brief catalog lock and
-- no table rewrite.
--
-- NO BACKFILL, and that is the deliberate INVERSE of 0013_onboarding_gates.
-- There, NULL meant "owes onboarding", so every pre-existing account had to be
-- stamped or the deploy would have trapped it in a first-run wizard. Here NULL
-- means "no attribution was ever captured", which is the truthful state of
-- every account that predates this migration. Stamping them would write the
-- same permanent lie #65 rules out for organic traffic (no synthetic
-- utm_source=direct), into the one column that can never be corrected: the
-- claim is write-once, so a wrong value here is wrong forever.
--
-- May share its number with a concurrent unit's migration (see #71 →
-- Mechanical conventions). Order-independent against any of them: it only adds
-- columns to `account` and writes no other table.

ALTER TABLE account ADD COLUMN IF NOT EXISTS attribution JSONB;
ALTER TABLE account ADD COLUMN IF NOT EXISTS attribution_claimed_at BIGINT;
