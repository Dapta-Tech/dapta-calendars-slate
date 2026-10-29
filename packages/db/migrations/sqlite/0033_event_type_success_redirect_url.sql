-- See migrations/postgres/0034_event_type_success_redirect_url.sql for the rationale.
--
-- Nullable, no default: every existing event keeps its confirmation screen.

ALTER TABLE event_type ADD COLUMN success_redirect_url TEXT;
