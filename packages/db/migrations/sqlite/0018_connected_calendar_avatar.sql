-- See migrations/postgres/0019_connected_calendar_avatar.sql for the rationale.
ALTER TABLE connected_calendar ADD COLUMN avatar_url text;
