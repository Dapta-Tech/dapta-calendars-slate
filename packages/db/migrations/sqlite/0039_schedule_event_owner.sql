-- See migrations/postgres/0040_schedule_event_owner.sql for the rationale.
ALTER TABLE schedule ADD COLUMN event_type_id TEXT;
CREATE INDEX IF NOT EXISTS schedule_event_type_idx ON schedule (event_type_id);
