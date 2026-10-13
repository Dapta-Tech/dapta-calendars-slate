-- See migrations/postgres/0022_member_brand_backup.sql for the rationale.
ALTER TABLE member ADD COLUMN brand_backup text;
ALTER TABLE member ADD COLUMN brand_applied_at integer;
