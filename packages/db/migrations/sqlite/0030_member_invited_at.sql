-- See migrations/postgres/0031_member_invited_at.sql for the rationale.
--
-- Nullable, no default: every existing row reads as "did not come from an
-- invitation", except the pending invitations, stamped with their own
-- created_at. BIGINT lands as INTEGER here, the standing convention for epoch-ms.

ALTER TABLE member ADD COLUMN invited_at INTEGER;

UPDATE member SET invited_at = created_at WHERE status = 'invited' AND invited_at IS NULL;

-- Invitation emails sent per account per UTC day (the atomic daily cap).
CREATE TABLE IF NOT EXISTS member_invite_quota (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
