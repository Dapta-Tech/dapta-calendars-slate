-- Additive (SAFE): onboarding gate 1 state on the account (ADR 0002).
-- Two nullable columns — `onboarding` holds the qualification answers keyed by
-- Forms' question bank (TEXT JSON here, JSONB on Postgres), and
-- `onboarding_completed_at` is the write-once claim (INTEGER epoch-ms here,
-- BIGINT on Postgres). No data rewrite, no drop. Gate 2 (setup) needs no column
-- at all — it is satisfied by the EXISTENCE of a published event type, so a host
-- who deletes their last one is guided again rather than stranded.

ALTER TABLE account ADD COLUMN onboarding TEXT;
ALTER TABLE account ADD COLUMN onboarding_completed_at INTEGER;

-- THE LOAD-BEARING LINE. NULL means "owes onboarding", so without this stamp
-- the deploy would trap every account that already exists: the seeded demo
-- account, every local instance, and every pilot host already using the
-- product would land in a first-run wizard on their next request. Stamping
-- here means the wizard only ever greets accounts created AFTER this migration.
UPDATE account
   SET onboarding_completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE onboarding_completed_at IS NULL;

-- Person-level qualification check: "has this human already qualified in ANOTHER
-- workspace?" resolves a member by upstream identity (external_id) or email
-- across accounts, so someone invited into a second workspace is never
-- re-interrogated. Both lookups are cross-account by construction, so neither is
-- served by the existing (account_id, external_id) index.
CREATE INDEX IF NOT EXISTS member_external_id_lookup_idx ON member (external_id);
CREATE INDEX IF NOT EXISTS member_email_lookup_idx ON member (email);
