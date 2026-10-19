-- See migrations/postgres/0026_oauth_record.sql for the rationale: the storage
-- of the embedded OAuth authorization server for the MCP connector, one row per
-- artifact keyed by (kind, id), bearer ids stored hashed, payload as JSON text.
--
-- BIGINT lands as INTEGER here, the standing dual-dialect convention for
-- epoch-ms instants; table and column names mirror Postgres 1:1.

CREATE TABLE IF NOT EXISTS oauth_record (
  kind         TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  grant_id     TEXT,
  uid          TEXT,
  account_id   TEXT,
  expires_at   INTEGER,
  consumed_at  INTEGER,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS oauth_record_grant_idx ON oauth_record (grant_id);

CREATE INDEX IF NOT EXISTS oauth_record_uid_idx ON oauth_record (kind, uid);

CREATE INDEX IF NOT EXISTS oauth_record_account_idx ON oauth_record (account_id, kind);

CREATE INDEX IF NOT EXISTS oauth_record_expires_idx ON oauth_record (expires_at);
