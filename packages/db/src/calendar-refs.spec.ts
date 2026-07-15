import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DisabledCalendarProvider, InMemoryCalendarProvider } from '@slate/calendar';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { sql } from 'drizzle-orm';
import { createBooking, getAvailability } from './repository';
import {
  deleteBookingReferences,
  loadBookingForCalendarWrite,
  loadBookingReferences,
  loadConflictConnectionRefs,
  loadDestinationConnectionRefs,
  writeBookingReference,
} from './calendar-refs';

// The CalendarProvider port, wired into the availability + reference paths.
// Everything must be a strict no-op on the OSS default (no connections / disabled
// provider) so a bare clone behaves exactly as before.
describe('calendar-refs (CalendarProvider wiring, SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  const CAL_REF = 'cal-ext-1';

  const WINDOW = () => {
    const fromMs = Date.now();
    return { fromMs, toMs: fromMs + 10 * 86_400_000 };
  };

  async function connectCalendar(
    opts: { destination: boolean; conflicts: boolean },
    externalId = CAL_REF,
  ): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email,
             is_destination, check_conflicts, created_at)
          VALUES (${id}, ${accountId}, ${memberId}, ${'google'}, ${externalId}, ${null},
             ${opts.destination ? 1 : 0}, ${opts.conflicts ? 1 : 0}, ${Date.now()})`,
    );
    return id;
  }

  async function getIntroCallEventTypeId(): Promise<string> {
    return (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
  });

  // --- AVAILABILITY: external busy subtracts from offered slots (E4/B9) ------

  it('subtracts external calendar busy times from the offered slots', async () => {
    const { fromMs, toMs } = WINDOW();
    const args = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', fromMs, toMs };

    // Baseline: no external calendar → local availability only.
    const baseline = await getAvailability(db, args);
    expect(baseline!.slots.length).toBeGreaterThan(1);
    const firstSlot = baseline!.slots[0]!.startUtc;
    const firstStartMs = new Date(firstSlot).getTime();

    // Connect a conflict-checked calendar and mark the first slot's hour BUSY.
    await connectCalendar({ destination: false, conflicts: true });
    const provider = new InMemoryCalendarProvider();
    provider.seedBusy(CAL_REF, [
      { startUtc: new Date(firstStartMs - 60_000).toISOString(), endUtc: new Date(firstStartMs + 60 * 60_000).toISOString() },
    ]);

    const withBusy = await getAvailability(db, args, provider);
    // The busied slot is gone, and strictly fewer slots are offered.
    expect(withBusy!.slots.map((s) => s.startUtc)).not.toContain(firstSlot);
    expect(withBusy!.slots.length).toBeLessThan(baseline!.slots.length);
  });

  it('is a no-op with a disabled provider or no connection (clone-and-run parity)', async () => {
    const { fromMs, toMs } = WINDOW();
    const args = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', fromMs, toMs };
    const baseline = await getAvailability(db, args);

    // Disabled provider → identical to no provider.
    const disabled = await getAvailability(db, args, new DisabledCalendarProvider());
    expect(disabled!.slots).toEqual(baseline!.slots);

    // Even an ENABLED provider with seeded busy does nothing when the host has no
    // conflict-checked connection — the provider is never consulted.
    const provider = new InMemoryCalendarProvider();
    provider.seedBusy(CAL_REF, [
      { startUtc: new Date(fromMs).toISOString(), endUtc: new Date(toMs).toISOString() },
    ]);
    const noConnection = await getAvailability(db, args, provider);
    expect(noConnection!.slots).toEqual(baseline!.slots);
  });

  // --- CONNECTION REF resolution -------------------------------------------

  it('resolves conflict vs destination connection refs independently', async () => {
    await connectCalendar({ destination: true, conflicts: false });
    expect(await loadConflictConnectionRefs(db, memberId)).toEqual([]);
    expect(await loadDestinationConnectionRefs(db, memberId)).toEqual([CAL_REF]);
  });

  // --- booking_reference persistence (C14) ----------------------------------

  it('loads the write context (destination refs + attendees) and round-trips a reference', async () => {
    await connectCalendar({ destination: true, conflicts: true });
    const { fromMs, toMs } = WINDOW();
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs,
      toMs,
    });
    const startMs = new Date(avail!.slots[0]!.startUtc).getTime();
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    expect(booked.ok).toBe(true);
    if (!booked.ok) return;

    const ctx = await loadBookingForCalendarWrite(db, booked.booking.uid);
    expect(ctx).not.toBeNull();
    expect(ctx!.destinationRefs).toEqual([CAL_REF]);
    expect(ctx!.attendeeEmails).toEqual(['sam@example.com']);
    expect(ctx!.organizerEmail).toBe('alex@example.com');

    // Persist a reference, read it back, then clear it (the cancel path).
    await writeBookingReference(db, {
      bookingId: ctx!.bookingId,
      type: 'calendar_event',
      externalEventId: 'evt-123',
      externalCalendarId: CAL_REF,
      meetingUrl: 'https://meet.example/xyz',
    });
    const refs = await loadBookingReferences(db, ctx!.bookingId);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.externalEventId).toBe('evt-123');
    expect(refs[0]!.meetingUrl).toBe('https://meet.example/xyz');

    await deleteBookingReferences(db, ctx!.bookingId);
    expect(await loadBookingReferences(db, ctx!.bookingId)).toHaveLength(0);
  });

  // --- PHASE 2: per-event calendar selection --------------------------------

  describe('event-aware conflict/destination resolution (Phase 2)', () => {
    it('falls back to the member-level default when the event has no override (no regression)', async () => {
      await connectCalendar({ destination: true, conflicts: true }, 'cal-a');
      await connectCalendar({ destination: false, conflicts: true }, 'cal-b');
      const eventTypeId = await getIntroCallEventTypeId();

      // No event_type_conflict_calendar rows, no destination_calendar_id set —
      // member default is BOTH conflict-checked calendars + the sole destination.
      expect((await loadConflictConnectionRefs(db, memberId, eventTypeId)).sort()).toEqual(['cal-a', 'cal-b']);
      expect(await loadDestinationConnectionRefs(db, memberId, eventTypeId)).toEqual(['cal-a']);
      // Omitting eventTypeId entirely is identical (today's call shape).
      expect((await loadConflictConnectionRefs(db, memberId)).sort()).toEqual(['cal-a', 'cal-b']);
    });

    it('uses the event-scoped conflict-calendar override when configured', async () => {
      await connectCalendar({ destination: true, conflicts: true }, 'cal-a');
      const calB = await connectCalendar({ destination: false, conflicts: true }, 'cal-b');
      const eventTypeId = await getIntroCallEventTypeId();

      // Configure this event to check ONLY cal-b, even though the member has
      // both check_conflicts calendars.
      await db.run(
        sql`INSERT INTO event_type_conflict_calendar (event_type_id, connected_calendar_id, created_at)
            VALUES (${eventTypeId}, ${calB}, ${Date.now()})`,
      );
      expect(await loadConflictConnectionRefs(db, memberId, eventTypeId)).toEqual(['cal-b']);
      // A DIFFERENT event type (or no eventTypeId) is unaffected — still both.
      expect((await loadConflictConnectionRefs(db, memberId)).sort()).toEqual(['cal-a', 'cal-b']);
    });

    it('uses the event-scoped destination override when configured, and falls back if disconnected', async () => {
      await connectCalendar({ destination: true, conflicts: true }, 'cal-a');
      const calB = await connectCalendar({ destination: false, conflicts: true }, 'cal-b');
      const eventTypeId = await getIntroCallEventTypeId();

      await db.run(sql`UPDATE event_type SET destination_calendar_id = ${calB} WHERE id = ${eventTypeId}`);
      expect(await loadDestinationConnectionRefs(db, memberId, eventTypeId)).toEqual(['cal-b']);

      // Disconnect cal-b (the override target) — resolution must fall back to
      // the member default (cal-a), never throw, never resolve to nothing.
      await db.run(sql`DELETE FROM connected_calendar WHERE id = ${calB}`);
      expect(await loadDestinationConnectionRefs(db, memberId, eventTypeId)).toEqual(['cal-a']);
    });

    it('getAvailability subtracts busy from ONLY the event-scoped conflict calendar', async () => {
      const calA = await connectCalendar({ destination: false, conflicts: true }, 'cal-a');
      const calB = await connectCalendar({ destination: false, conflicts: true }, 'cal-b');
      const eventTypeId = await getIntroCallEventTypeId();
      // Scope this event to cal-a ONLY.
      await db.run(
        sql`INSERT INTO event_type_conflict_calendar (event_type_id, connected_calendar_id, created_at)
            VALUES (${eventTypeId}, ${calA}, ${Date.now()})`,
      );

      const { fromMs, toMs } = WINDOW();
      const args = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', fromMs, toMs };
      const baseline = await getAvailability(db, args);
      const firstStartMs = new Date(baseline!.slots[0]!.startUtc).getTime();

      const provider = new InMemoryCalendarProvider();
      // Busy on cal-b (NOT in this event's scoped set) must NOT remove the slot.
      provider.seedBusy('cal-b', [
        { startUtc: new Date(firstStartMs - 60_000).toISOString(), endUtc: new Date(firstStartMs + 60 * 60_000).toISOString() },
      ]);
      const withIrrelevantBusy = await getAvailability(db, args, provider);
      expect(withIrrelevantBusy!.slots.map((s) => s.startUtc)).toContain(baseline!.slots[0]!.startUtc);

      // Busy on cal-a (the scoped calendar) DOES remove the slot.
      const provider2 = new InMemoryCalendarProvider();
      provider2.seedBusy('cal-a', [
        { startUtc: new Date(firstStartMs - 60_000).toISOString(), endUtc: new Date(firstStartMs + 60 * 60_000).toISOString() },
      ]);
      const withScopedBusy = await getAvailability(db, args, provider2);
      expect(withScopedBusy!.slots.map((s) => s.startUtc)).not.toContain(baseline!.slots[0]!.startUtc);
    });

    it('loadBookingForCalendarWrite resolves the booking event type\'s destination override', async () => {
      await connectCalendar({ destination: true, conflicts: true }, 'cal-a');
      const calB = await connectCalendar({ destination: false, conflicts: true }, 'cal-b');
      const eventTypeId = await getIntroCallEventTypeId();
      await db.run(sql`UPDATE event_type SET destination_calendar_id = ${calB} WHERE id = ${eventTypeId}`);

      const { fromMs, toMs } = WINDOW();
      const avail = await getAvailability(db, { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', fromMs, toMs });
      const startMs = new Date(avail!.slots[0]!.startUtc).getTime();
      const booked = await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startMs,
        attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
        answers: { company: 'Acme' },
      });
      expect(booked.ok).toBe(true);
      if (!booked.ok) return;

      const ctx = await loadBookingForCalendarWrite(db, booked.booking.uid);
      // The event's override (cal-b) wins over the member's actual destination (cal-a).
      expect(ctx!.destinationRefs).toEqual(['cal-b']);
    });
  });
});
