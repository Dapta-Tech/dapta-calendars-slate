-- When a member was invited by an admin of this account, for members that came
-- from an invitation (additive + SAFE).
--
--   - member.invited_at: epoch ms of the invitation. Written by inviteMember and
--     never cleared, not even when the invitation is accepted. NULL for every
--     member that came in any other way: the first sign-in to an account, a
--     sign-in through a token the identity service minted for that account,
--     the seed.
--
-- Why it exists: a dashboard request may name another account to act in
-- (x-dcal-workspace, ADR 0010). That is honored only for memberships THIS app
-- granted, which is what this column marks. A member row created by a sign-in
-- through a token for the account stays reachable only through such a token, so
-- removing someone upstream still ends their access here.
--
-- Backfill: a row still `invited` can only have come from inviteMember, so it is
-- stamped with its own created_at. Rows that already accepted cannot be told
-- apart and stay NULL: they keep the access they have today, through the token.
--
--   - member_invite_quota: how many invitation emails (new or resent) each
--     account sent per UTC day. Taken with one atomic upsert before each send,
--     so concurrent requests cannot all slip under the daily cap, and kept
--     apart from `member` so deleting members gives nothing back.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan). The backfill touches only pending invitations in a small
-- table. The new table is empty. All bounded by lock_timeout so a long
-- transaction makes the boot fail fast and retry.
SET lock_timeout = '5s';

ALTER TABLE member ADD COLUMN IF NOT EXISTS invited_at BIGINT;

UPDATE member SET invited_at = created_at WHERE status = 'invited' AND invited_at IS NULL;

CREATE TABLE IF NOT EXISTS member_invite_quota (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

RESET lock_timeout;
