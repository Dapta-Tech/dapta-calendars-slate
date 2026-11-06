/**
 * The custom-hours rules (a test fixture, excluded from the build), written once and run on both dialects:
 * `event-custom-hours.spec.ts` (SQLite, in memory) and
 * `event-custom-hours.pg.spec.ts` (a real Postgres when `DATABASE_URL` is one).
 * Every fixture is unique per run, because a Postgres `DATABASE_URL` is a
 * shared database other specs also seed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EventCustomHours } from '@slate/types';
import { sql, type Db } from './client';
import {
  createEventType,
  createSchedule,
  deleteEventType,
  deleteSchedule,
  getEventTypeById,
  getSchedule,
  listSchedules,
  updateEventType,
} from './crud';
import { loadAvailabilityRules } from './repository';
import { isUsableSchedule } from './event-custom-hours';

const WEEKDAYS: EventCustomHours = {
  timeZone: 'America/Bogota',
  ranges: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
};
const TUESDAY_MORNING: EventCustomHours = {
  timeZone: 'America/Bogota',
  ranges: [{ days: [2], start: '10:00', end: '12:00' }],
};

export function customHoursSuite(name: string, getDb: () => Promise<Db>): void {
  describe(`event custom hours (${name})`, () => {
    let db: Db;
    let accountId: string;
    let memberId: string;
    let workingHoursId: string;

    const memberDefault = async () =>
      (await db.get<{ d: string | null }>(sql`SELECT default_schedule_id AS d FROM member WHERE id = ${memberId}`))?.d ??
      null;
    const ownedCount = async (eventTypeId: string) =>
      Number(
        (await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM schedule WHERE event_type_id = ${eventTypeId}`))?.n ??
          0,
      );
    const orphanRules = async () =>
      Number(
        (
          await db.get<{ n: number }>(
            sql`SELECT COUNT(*) AS n FROM availability a
                WHERE NOT EXISTS (SELECT 1 FROM schedule s WHERE s.id = a.schedule_id)`,
          )
        )?.n ?? 0,
      );
    const storedScheduleId = async (eventTypeId: string) =>
      (await db.get<{ s: string | null }>(sql`SELECT schedule_id AS s FROM event_type WHERE id = ${eventTypeId}`))?.s ??
      null;
    const newEvent = async (input: Record<string, unknown> = {}) => {
      const r = await createEventType(db, accountId, memberId, {
        slug: `intro-${randomUUID().slice(0, 8)}`,
        title: 'Intro',
        lengthMinutes: 30,
        ...input,
      });
      if (!r.ok) throw new Error('create failed');
      return r.value;
    };

    beforeEach(async () => {
      db = await getDb();
      accountId = randomUUID();
      memberId = randomUUID();
      await db.run(
        sql`INSERT INTO account (id, code, name, created_at)
            VALUES (${accountId}, ${'ch' + accountId.slice(0, 6)}, ${'Hours Co'}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
            VALUES (${memberId}, ${accountId}, ${'h' + memberId.slice(0, 8)}, ${'Host'},
              ${`h-${memberId}@example.com`}, ${'UTC'}, ${Date.now()})`,
      );
      workingHoursId = (
        await createSchedule(db, accountId, memberId, {
          name: 'Working hours',
          timeZone: 'UTC',
          rules: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null }],
        })
      ).id;
    });

    it('creates an event with custom hours and reads them back', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      expect(e.customHours).toEqual(WEEKDAYS);
      expect(e.scheduleId).toBeNull();
      const sid = await storedScheduleId(e.id);
      expect(sid).not.toBeNull();
      // Slot generation reads the event's schedule: the custom rules are there.
      expect(await loadAvailabilityRules(db, sid!)).toEqual([
        { days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null },
      ]);
    });

    it('lists the reusable schedules with the default marked', async () => {
      const second = await createSchedule(db, accountId, memberId, { name: 'Evenings', timeZone: 'UTC' });
      const list = await listSchedules(db, memberId);
      expect(list.map((s) => [s.id, s.isDefault])).toEqual([
        [workingHoursId, true],
        [second.id, false],
      ]);
    });

    it('keeps custom hours out of the reusable schedules', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      const list = await listSchedules(db, memberId);
      expect(list.map((s) => s.id)).toEqual([workingHoursId]);
      expect(await getSchedule(db, accountId, (await storedScheduleId(e.id))!)).toBeNull();
    });

    it('never promotes custom hours to the default schedule', async () => {
      await newEvent({ customHours: WEEKDAYS });
      expect(await memberDefault()).toBe(workingHoursId);
      await deleteSchedule(db, accountId, workingHoursId);
      expect(await memberDefault()).toBeNull();
    });

    it('cannot delete custom hours through the schedule API path', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      await deleteSchedule(db, accountId, (await storedScheduleId(e.id))!);
      expect((await getEventTypeById(db, accountId, e.id))!.customHours).toEqual(WEEKDAYS);
    });

    it('replaces custom hours on update without leaving the old ones behind', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      const updated = await updateEventType(db, accountId, e.id, { customHours: TUESDAY_MORNING });
      expect(updated.ok && updated.value.customHours).toEqual(TUESDAY_MORNING);
      expect(await ownedCount(e.id)).toBe(1);
      expect(await orphanRules()).toBe(0);
    });

    it('switching to working hours deletes the custom hours', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      const r = await updateEventType(db, accountId, e.id, { customHours: null, scheduleId: null });
      expect(r.ok && r.value.customHours).toBeNull();
      expect(await storedScheduleId(e.id)).toBeNull();
      expect(await ownedCount(e.id)).toBe(0);
      expect(await orphanRules()).toBe(0);
    });

    it('a client that only picks a schedule also leaves custom hours cleanly', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      const r = await updateEventType(db, accountId, e.id, { scheduleId: workingHoursId });
      expect(r.ok && r.value.scheduleId).toBe(workingHoursId);
      expect(r.ok && r.value.customHours).toBeNull();
      expect(await ownedCount(e.id)).toBe(0);
    });

    it('an update that does not mention availability keeps the custom hours', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      const r = await updateEventType(db, accountId, e.id, { title: 'Renamed' });
      expect(r.ok && r.value.customHours).toEqual(WEEKDAYS);
    });

    it('moves an event from a saved schedule to custom hours', async () => {
      const e = await newEvent({ scheduleId: workingHoursId });
      const r = await updateEventType(db, accountId, e.id, { customHours: TUESDAY_MORNING });
      expect(r.ok && r.value.customHours).toEqual(TUESDAY_MORNING);
      expect(r.ok && r.value.scheduleId).toBeNull();
      expect(await listSchedules(db, memberId)).toHaveLength(1);
    });

    it('a save that fails part-way changes nothing: hours and fields land together or not at all', async () => {
      const taken = await newEvent();
      const e = await newEvent({ customHours: WEEKDAYS });
      // The slug clashes with another event's (a unique index): the event's own
      // UPDATE fails inside the transaction that would also replace its hours.
      await expect(updateEventType(db, accountId, e.id, { slug: taken.slug, customHours: TUESDAY_MORNING })).rejects.toThrow();
      const after = await getEventTypeById(db, accountId, e.id);
      expect(after!.customHours).toEqual(WEEKDAYS);
      expect(after!.slug).toBe(e.slug);
      expect(await ownedCount(e.id)).toBe(1);
      expect(await orphanRules()).toBe(0);
    });

    it('only the account’s reusable schedules of the event’s own host are usable', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      expect(await isUsableSchedule(db, { accountId, scheduleId: workingHoursId, memberId })).toBe(true);
      expect(await isUsableSchedule(db, { accountId, scheduleId: workingHoursId, memberId: null })).toBe(true);
      expect(await isUsableSchedule(db, { accountId, scheduleId: workingHoursId, memberId: 'someone-else' })).toBe(false);
      expect(await isUsableSchedule(db, { accountId: 'another-account', scheduleId: workingHoursId, memberId })).toBe(false);
      expect(await isUsableSchedule(db, { accountId, scheduleId: (await storedScheduleId(e.id))!, memberId })).toBe(false);
    });

    it('deleting the event deletes its custom hours', async () => {
      const e = await newEvent({ customHours: WEEKDAYS });
      await deleteEventType(db, accountId, e.id);
      expect(await ownedCount(e.id)).toBe(0);
      expect(await orphanRules()).toBe(0);
    });

    it('an event without custom hours reads as before', async () => {
      const e = await newEvent({ scheduleId: workingHoursId });
      expect(e.customHours).toBeNull();
      expect(e.scheduleId).toBe(workingHoursId);
    });
  });
}
