-- See migrations/postgres/0023_account_branding.sql for the rationale.
CREATE TABLE IF NOT EXISTS account_branding (
  account_id TEXT PRIMARY KEY,
  config     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
