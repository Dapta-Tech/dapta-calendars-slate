-- See migrations/postgres/0020_slot_reservation_uid_index.sql for the rationale.
CREATE INDEX IF NOT EXISTS slot_reservation_uid_idx ON slot_reservation (uid);
