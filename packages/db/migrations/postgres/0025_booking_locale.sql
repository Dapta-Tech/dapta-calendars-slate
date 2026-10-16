-- The language the invitee booked in, snapshotted onto the booking (additive + SAFE).
--
--   - booking.locale: 'en' | 'es', or NULL. The invitee's emails are written in
--     it; the host's copies keep the host's own language (member.locale). It is
--     recorded only when it is KNOWN: the booking page's language, or an API
--     caller's explicit `attendee.language`. NULL is every booking taken before
--     this column existed and every write that names no language, and it reads
--     exactly as before: the invitee's mail follows the host's language.
--
-- Why not `booking_attendee.language` (0018): that column feeds the CRM contact
-- property, and the v2 compatibility surface fills a default 'en' into it when
-- its caller names no language. Reading it here would switch the invitee mail of
-- every such booking already taken for a Spanish-speaking host to English. A
-- separate column that holds only an explicit choice keeps every existing
-- booking's mail where it is.
--
-- Migration safety: ADD COLUMN, nullable, no default, is a catalog-only change
-- in Postgres (no rewrite, no scan). It still takes a brief ACCESS EXCLUSIVE
-- lock on a hot table, so the lock_timeout makes it fail fast rather than queue
-- every booking read behind a long-running transaction; a failed boot retries.
SET lock_timeout = '5s';

ALTER TABLE booking ADD COLUMN IF NOT EXISTS locale TEXT;

RESET lock_timeout;
