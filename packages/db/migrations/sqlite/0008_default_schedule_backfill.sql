-- Backfill member.default_schedule_id (SAFE, idempotent, data-only):
-- members who already created schedules before createSchedule() started
-- assigning a default (QA fix 2) get their OLDEST schedule as default —
-- the same choice deleteSchedule() has always made when re-pointing.
-- No schema change; pure UPDATE over existing rows.

UPDATE member SET default_schedule_id = (
  SELECT s.id FROM schedule s
  WHERE s.member_id = member.id
  ORDER BY s.created_at ASC, s.id ASC
  LIMIT 1
)
WHERE default_schedule_id IS NULL
  AND EXISTS (SELECT 1 FROM schedule s2 WHERE s2.member_id = member.id);
