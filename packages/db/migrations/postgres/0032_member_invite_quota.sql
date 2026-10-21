-- How many invitation emails (new or resent) each account sent per UTC day
-- (additive + SAFE).
--
--   - member_invite_quota: one row per account and day, `sent` counted with one
--     atomic upsert before each send (`takeInvitationQuota`), so concurrent
--     requests cannot all slip under the daily cap. Kept apart from `member`, so
--     deleting members gives nothing back. Rows are tiny and one per active
--     account per day; nothing reads past days, so pruning them is optional.
--
-- Migration safety: a new, empty table; nothing else is touched. Bounded by
-- lock_timeout like every migration here.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS member_invite_quota (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

RESET lock_timeout;
