-- See migrations/postgres/0032_member_invite_quota.sql for the rationale.
--
-- A new, empty table: invitation emails sent per account per UTC day, the
-- atomic daily cap.

CREATE TABLE IF NOT EXISTS member_invite_quota (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
