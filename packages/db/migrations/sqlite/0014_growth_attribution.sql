-- Additive (SAFE): O2 growth attribution on the account (#94, decided at #65).
-- Two nullable columns — `attribution` holds the 7-key allowlist blob captured
-- at the front door (TEXT JSON here, JSONB on Postgres), and
-- `attribution_claimed_at` is the write-once claim (INTEGER epoch-ms here,
-- BIGINT on Postgres). No data rewrite, no drop.
--
-- NO BACKFILL, and that is the deliberate INVERSE of 0012_onboarding_gates.
-- There, NULL meant "owes onboarding", so every pre-existing account had to be
-- stamped or the deploy would have trapped it in a first-run wizard. Here NULL
-- means "no attribution was ever captured", which is the truthful state of
-- every account that predates this migration. Stamping them would write the
-- same permanent lie #65 rules out for organic traffic (no synthetic
-- utm_source=direct), into the one column that can never be corrected: the
-- claim is write-once, so a wrong value here is wrong forever.

ALTER TABLE account ADD COLUMN attribution TEXT;
ALTER TABLE account ADD COLUMN attribution_claimed_at INTEGER;
