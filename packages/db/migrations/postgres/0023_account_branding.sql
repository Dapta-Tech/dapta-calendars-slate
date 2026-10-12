-- The workspace brand kit: one row per account. Additive: an account with no
-- row has no kit, and nothing anywhere changes for it.
--
--   config  the kit as JSON, validated by `brandKitSchema` in @slate/types:
--           a logo, the accent and canvas, and the font, corners, buttons and
--           card style axes. Every key optional.
--
-- A host's page never reads this table. "Apply kit" SNAPSHOTS it into the
-- member's own branding (keeping the previous look in `member.brand_backup`,
-- 0022), so a kit edit never moves a live page. Team pages, which store no
-- branding of their own, render it directly.
CREATE TABLE IF NOT EXISTS account_branding (
  account_id  TEXT PRIMARY KEY,
  config      JSONB NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
