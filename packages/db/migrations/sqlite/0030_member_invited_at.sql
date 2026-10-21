-- See migrations/postgres/0031_member_invited_at.sql for the rationale.
--
-- Nullable, no default: every existing row reads as "did not come from an
-- invitation", except the pending invitations, stamped with their own
-- created_at. BIGINT lands as INTEGER here, the standing convention for epoch-ms.

ALTER TABLE member ADD COLUMN invited_at INTEGER;

UPDATE member SET invited_at = created_at WHERE status = 'invited' AND invited_at IS NULL;
