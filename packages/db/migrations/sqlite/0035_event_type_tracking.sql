-- See migrations/postgres/0036_event_type_tracking.sql for the rationale.
--
-- Nullable JSON text, no default: every existing event loads no tracking.

ALTER TABLE event_type ADD COLUMN tracking TEXT;
