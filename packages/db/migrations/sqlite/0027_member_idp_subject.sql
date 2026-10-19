-- See migrations/postgres/0028_member_idp_subject.sql for the rationale.
--
-- Nullable, no default: every existing row reads as "not linked yet" and "not
-- seen since the upgrade". NULLs are distinct in a SQLite unique index too, so
-- only recorded subjects are constrained (one member per subject within an
-- account). BIGINT lands as INTEGER here, the standing convention for epoch-ms.

ALTER TABLE member ADD COLUMN idp_subject TEXT;
ALTER TABLE member ADD COLUMN login_seen_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS member_idp_subject_account_idx ON member (idp_subject, account_id);
CREATE INDEX IF NOT EXISTS member_external_id_idx ON member (external_id);
