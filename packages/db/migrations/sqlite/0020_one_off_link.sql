-- See migrations/postgres/0021_one_off_link.sql for the rationale: what a
-- one-off link is (a grant over an existing event type, never a meeting), why
-- it is not a security control, why the token is stored in clear
-- (docs/adr/0003-public-tokens-have-two-storage-policies.md), and why a cancel
-- never revives a consumed link.
--
-- BIGINT lands as INTEGER here, which is the standing dual-dialect convention
-- for epoch-ms instants; table and column names mirror Postgres 1:1 so the
-- repository stays dialect-agnostic.

CREATE TABLE IF NOT EXISTS one_off_link (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT    NOT NULL,
  event_type_id         TEXT    NOT NULL,
  token                 TEXT    NOT NULL,
  created_by_member_id  TEXT,
  created_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  consumed_booking_id   TEXT,
  revoked_at            INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS one_off_link_token_uq ON one_off_link (token);

CREATE INDEX IF NOT EXISTS one_off_link_account_event_idx
  ON one_off_link (account_id, event_type_id, created_at);
