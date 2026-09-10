-- The connected account's own profile photo, as reported by the calendar
-- backend. Additive and nullable: a deployment whose backend does not report one
-- keeps NULL here forever and the public page falls back to the initial tile,
-- exactly as it does today.
--
-- It lives on the CONNECTION, never on `member.avatar_url`. That column is the
-- host's explicit choice in the studio; a sync writing into it would silently
-- turn a fallback into a saved value that outlives the connection.
ALTER TABLE connected_calendar ADD COLUMN IF NOT EXISTS avatar_url text;
