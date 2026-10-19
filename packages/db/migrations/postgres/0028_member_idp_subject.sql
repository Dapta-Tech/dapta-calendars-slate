-- The member's user id at the external OAuth authorization server that MCP
-- clients sign in with (additive + SAFE).
--
--   - member.idp_subject: the `sub` of that server's access tokens for this
--     person. The host login provider records it at web login (and when a login
--     adopts an invite), writing only when it is missing or different. A sign-in
--     token at the MCP door finds the person's members by it. NULL until the
--     person signs in to the web app once with a login that carries it (it is
--     recorded whether or not the MCP signs in through that server yet, so the
--     switch finds people already linked), and on every deployment whose login
--     provider records none.
--
-- One member per subject within an account: the latest web login wins (the
-- previous holder is cleared in the same transaction). The unique index makes
-- that an invariant rather than a convention, and its leading column serves the
-- door's lookup by subject across accounts. NULLs are distinct in a Postgres
-- unique index, so every existing row (all NULL) is unaffected.
--
-- Migration safety: one ADD COLUMN, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. The index is built over a column that is NULL on
-- every row of a small table.
SET lock_timeout = '5s';

ALTER TABLE member ADD COLUMN IF NOT EXISTS idp_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS member_idp_subject_account_idx ON member (idp_subject, account_id);

RESET lock_timeout;
