-- See migrations/postgres/0033_event_type_rr_distribution.sql for the rationale.
--
-- Nullable, no default: every existing event reads as 'availability'.

ALTER TABLE event_type ADD COLUMN rr_distribution TEXT;
