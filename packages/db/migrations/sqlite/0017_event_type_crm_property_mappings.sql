-- The SQLite twin of postgres/0018_event_type_crm_property_mappings.sql --
-- see that file for the full reasoning and the document shape.
--
-- Purely additive: one nullable column, no default, no backfill, so this file
-- is order-independent and its number may collide with a concurrent unit's
-- (#71, Mechanical conventions).
--
-- TEXT rather than JSONB: the portable subset of the dual-dialect schema stores
-- JSON documents as text, exactly as `booking_fields` and `reminders` already
-- do on this table. No IF NOT EXISTS on ADD COLUMN -- SQLite has no such form;
-- migrate.ts applies each file once, keyed on its filename.
ALTER TABLE event_type ADD COLUMN crm_property_mappings TEXT;

-- The attendee's notification language (`en` | `es`). `attendeeSchema` has
-- always accepted it and this layer has always dropped it, so H2's
-- attendee-language mapping would have had nothing to deliver. NULLABLE: every
-- booking taken before now, and every caller that omits it.
ALTER TABLE booking_attendee ADD COLUMN language TEXT;
