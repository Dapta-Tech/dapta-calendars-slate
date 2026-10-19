-- The member's user id at the external OAuth authorization server that MCP
-- clients sign in with, and when a verified web login last resolved the member
-- (additive + SAFE).
--
--   - member.idp_subject: the `sub` of that server's access tokens for this
--     person. The host login provider records it at web login (and when a login
--     adopts an invite), writing only when it is missing or different. A sign-in
--     token at the MCP door finds the person by it, then the person's members in
--     every account through `external_id` (the same upstream user id in each).
--     NULL until the person signs in to the web app once with a login that
--     carries it (it is recorded whether or not the MCP signs in through that
--     server yet, so the switch finds people already linked), and on every
--     deployment whose login provider records none.
--   - member.login_seen_at: epoch ms the identity service last vouched for the
--     member (the issue time of the token of a verified web login), refreshed
--     at most once a day, never backwards. The MCP door honors only members
--     seen within OAUTH_LINK_MAX_AGE_DAYS: this app is not told when someone is
--     removed upstream, so MCP access ends when the web's would. NULL until the
--     member's next web login.
--
-- One member per subject within an account: the latest web login wins (the
-- previous holder is cleared in the same transaction). The unique index makes
-- that an invariant rather than a convention, and its leading column serves the
-- door's lookup by subject across accounts. NULLs are distinct in a Postgres
-- unique index, so every existing row (all NULL) is unaffected. The plain index
-- on external_id serves the lookup of the person's other members; the existing
-- (account_id, external_id) index cannot, its leading column is the account.
--
-- Migration safety: two ADD COLUMNs, nullable, no default: catalog-only (no
-- rewrite, no scan), bounded by lock_timeout so a long transaction makes the
-- boot fail fast and retry. The indexes are built over a small table, one of
-- them over a column that is NULL on every row.
SET lock_timeout = '5s';

ALTER TABLE member ADD COLUMN IF NOT EXISTS idp_subject TEXT;
ALTER TABLE member ADD COLUMN IF NOT EXISTS login_seen_at BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS member_idp_subject_account_idx ON member (idp_subject, account_id);
CREATE INDEX IF NOT EXISTS member_external_id_idx ON member (external_id);

RESET lock_timeout;
