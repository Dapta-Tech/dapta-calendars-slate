-- Per-event calendar selection (additive + SAFE):
--   - event_type_conflict_calendar — the set of connected calendars THIS event
--     checks for conflicts (availability busy-subtraction). Zero rows for an
--     event = unchanged behavior: fall back to the host's member-level
--     `check_conflicts = 1` calendars (calendar-refs.ts loadConflictConnectionRefs).
--   - event_type.destination_calendar_id — the connected calendar THIS event
--     writes booked events to. NULL = unchanged behavior: fall back to the
--     host's member-level `is_destination = 1` calendar
--     (calendar-refs.ts loadDestinationConnectionRefs).
-- No DB-level FK constraints — matches this schema's existing convention
-- (e.g. booking_host, event_type_host): referential cleanup is app-level
-- (crud.ts deleteEventType / parity.ts deleteConnection), same as elsewhere.

CREATE TABLE event_type_conflict_calendar (
  event_type_id         TEXT NOT NULL,
  connected_calendar_id TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (event_type_id, connected_calendar_id)
);
CREATE INDEX event_type_conflict_calendar_event_idx ON event_type_conflict_calendar (event_type_id);
CREATE INDEX event_type_conflict_calendar_calendar_idx ON event_type_conflict_calendar (connected_calendar_id);

ALTER TABLE event_type ADD COLUMN destination_calendar_id TEXT;
