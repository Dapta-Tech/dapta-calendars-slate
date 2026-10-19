-- See migrations/postgres/0028_member_idp_subject.sql for the rationale.
--
-- Nullable, no default: every existing row reads as "not linked yet". NULLs are
-- distinct in a SQLite unique index too, so only recorded subjects are
-- constrained (one member per subject within an account).

ALTER TABLE member ADD COLUMN idp_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS member_idp_subject_account_idx ON member (idp_subject, account_id);
