-- OAuth authorization server storage for the MCP connector. Additive and SAFE:
-- one NEW table and its indexes, nothing altered. No existing table is read,
-- locked or rewritten, so a running deployment is untouched; the table stays
-- empty unless OAUTH_ENABLED=true.
--
-- WHAT THIS TABLE IS. The persistence of the embedded authorization server
-- (oidc-provider): one row per stored artifact, in the shape every
-- oidc-provider adapter uses, keyed by (kind, id).
--
--   kind         the model: Grant, RefreshToken, AuthorizationCode, Client
--                (dynamically registered only), Interaction, Session, plus two
--                of ours: GrantMeta (what the Connected apps list shows for a
--                grant) and ConsentTicket (the single-use proof that a person
--                approved or denied a consent screen).
--   id           the artifact id. Bearer values (refresh tokens, codes, session
--                and interaction ids, tickets) are stored as their SHA-256, never
--                in the clear; grant and client ids are not secrets.
--   payload      the artifact as JSON text. Never queried inside, so TEXT on
--                both dialects rather than jsonb.
--   grant_id     the connection an artifact belongs to: revoking a connection
--                is one DELETE on this column.
--   uid          oidc-provider's secondary lookup key (sessions).
--   account_id   the Calendars account a GrantMeta row belongs to, so the
--                Connected apps list is one indexed, account-scoped read
--                (invariant 4). NULL on every other kind.
--   expires_at   epoch ms; NULL never expires. Expired rows are invisible to
--                reads and purged in the background.
--   consumed_at  epoch ms an authorization code or refresh token was spent.
--
-- NO FOREIGN KEYS, matching every other table in this schema.

CREATE TABLE IF NOT EXISTS oauth_record (
  kind         TEXT   NOT NULL,
  id           TEXT   NOT NULL,
  payload      TEXT   NOT NULL,
  grant_id     TEXT,
  uid          TEXT,
  account_id   TEXT,
  expires_at   BIGINT,
  consumed_at  BIGINT,
  PRIMARY KEY (kind, id)
);

-- Revoke a whole connection: refresh tokens, codes, the grant and its meta row.
CREATE INDEX IF NOT EXISTS oauth_record_grant_idx ON oauth_record (grant_id);

-- oidc-provider's findByUid (sessions).
CREATE INDEX IF NOT EXISTS oauth_record_uid_idx ON oauth_record (kind, uid);

-- The Connected apps list, account-scoped first.
CREATE INDEX IF NOT EXISTS oauth_record_account_idx ON oauth_record (account_id, kind);

-- The background purge of expired rows.
CREATE INDEX IF NOT EXISTS oauth_record_expires_idx ON oauth_record (expires_at);
