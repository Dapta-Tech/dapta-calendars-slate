-- H1a (#92 / #63): one encrypted third-party integration credential per
-- (account, provider). Purely additive: a new table plus its unique index, so
-- this migration is order-independent against anything a concurrent unit ships
-- and its number may safely collide (#71, Mechanical conventions).
--
-- `token_cipher` holds an AES-256-GCM envelope (`v1.<iv>.<tag>.<ciphertext>`)
-- bound to (account_id, provider); it is NULLABLE because disconnecting scrubs
-- the credential while KEEPING the row -- `booking_reference.destination` points
-- at this id, so the id must survive a disconnect/reconnect cycle or a later
-- cancellation would create a duplicate meeting instead of updating one.
CREATE TABLE IF NOT EXISTS account_integration (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  provider           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'connected',
  token_cipher       TEXT,
  label              TEXT,
  token_last4        TEXT,
  last_check_at      INTEGER,
  last_check_ok      INTEGER,
  last_check_detail  TEXT,
  last_error_detail  TEXT,  -- TEXT JSON (jsonb on Postgres)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- One credential per account per vendor (#63: "Scope: one credential per
-- account"). This is also what makes reconnect an UPDATE of the same row.
CREATE UNIQUE INDEX IF NOT EXISTS account_integration_account_provider_uq
  ON account_integration (account_id, provider);
