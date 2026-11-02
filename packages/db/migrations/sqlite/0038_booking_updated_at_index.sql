-- See migrations/postgres/0039_booking_updated_at_index.sql for the rationale.
CREATE INDEX IF NOT EXISTS booking_account_updated_idx ON booking (account_id, updated_at);
