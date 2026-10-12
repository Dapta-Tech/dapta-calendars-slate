-- A one-step undo for a look applied to a host's booking page. Additive and
-- nullable: a host who never applies one keeps NULL in both forever, and their
-- page renders exactly as it does today.
--
--   member.brand_backup     the accent and the ten style axes as they were stored
--                           immediately before the last apply, plus what applied
--                           it ('new-look' from the studio's one-click preset,
--                           'kit' from the workspace brand kit). NULL = nothing to
--                           revert.
--   member.brand_applied_at epoch-ms of that apply; NULL when never applied or
--                           already reverted.
--
-- The page never reads either column: what renders is always the member's own
-- stored branding, so an apply is a snapshot written into it, never a live link.
ALTER TABLE member ADD COLUMN IF NOT EXISTS brand_backup jsonb;
ALTER TABLE member ADD COLUMN IF NOT EXISTS brand_applied_at bigint;
