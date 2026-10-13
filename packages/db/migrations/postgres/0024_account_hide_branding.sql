-- The account's choice to hide the Dapta branding on its public pages (additive + SAFE).
--
--   - account.hide_branding: 0 (the default, branding shows) or 1 (the account
--     asked to hide it). It is a CHOICE, not a verdict: the public render hides
--     the branding only while the cached Dapta AI entitlement on the same row
--     (dapta_entitlement, migration 0008) also reads 'paid'. When a subscription
--     lapses the choice stays stored, the branding comes back on its own, and a
--     customer who re-subscribes gets their choice back without touching it.
--
-- INTEGER 0/1, not BOOLEAN, so it reads the same as on SQLite (event_type.hidden).
-- The DEFAULT backfills every existing account to "branding on": no live page moves.

ALTER TABLE account ADD COLUMN IF NOT EXISTS hide_branding INTEGER NOT NULL DEFAULT 0;
