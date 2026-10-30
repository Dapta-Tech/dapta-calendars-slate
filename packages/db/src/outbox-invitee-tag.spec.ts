import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { enqueueOutbox, listOutbox, markOutboxDone, tagCalendarChangeWithInviteeEmail } from './outbox';

/**
 * The invitee email marks the calendar change it goes out with, so the
 * calendar write mutes the provider's own invitation only for that exact
 * change (F4 of the 2026-10-30 production E2E).
 */
describe('tagCalendarChangeWithInviteeEmail', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
  });

  const calendarRows = async (uid: string) => listOutbox(db, { kind: 'calendar', bookingUid: uid });

  it('marks the newest waiting row of that change, and only that one', async () => {
    const older = await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: 'bk-1', now: 100 });
    const newer = await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: 'bk-1', now: 200 });
    const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-1', now: 300 });

    expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-1', action: 'reschedule', emailOutboxId: 'em-1' })).toBe(true);

    const byId = Object.fromEntries((await calendarRows('bk-1')).map((r) => [r.id, r.payload]));
    expect(byId[newer]).toBe(JSON.stringify({ inviteeEmailId: 'em-1' }));
    expect(byId[older]).toBeNull();
    expect(byId[create]).toBeNull();
  });

  it('a change that already ran, another booking, or no calendar at all: nothing is marked', async () => {
    const done = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-2', now: 100 });
    await markOutboxDone(db, done);
    await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-other', now: 100 });

    expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-2', action: 'create', emailOutboxId: 'em-2' })).toBe(false);
    expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-none', action: 'delete', emailOutboxId: 'em-3' })).toBe(false);
    expect((await calendarRows('bk-other'))[0]!.payload).toBeNull();
  });

  it('two changes marking at once take two different rows, never the same one twice', async () => {
    const first = await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: 'bk-3', now: 100 });
    const second = await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: 'bk-3', now: 200 });
    const marks = await Promise.all([
      tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-3', action: 'reschedule', emailOutboxId: 'em-a' }),
      tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-3', action: 'reschedule', emailOutboxId: 'em-b' }),
    ]);
    expect(marks).toEqual([true, true]);
    const payloads = (await calendarRows('bk-3')).filter((r) => [first, second].includes(r.id)).map((r) => r.payload);
    expect(payloads.sort()).toEqual([
      JSON.stringify({ inviteeEmailId: 'em-a' }),
      JSON.stringify({ inviteeEmailId: 'em-b' }),
    ]);
    // A third email for the same change finds no waiting row left to take.
    expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-3', action: 'reschedule', emailOutboxId: 'em-c' })).toBe(false);
  });

  it('a row a worker has already claimed is not marked: it read its payload already', async () => {
    const claimed = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-4', now: 100 });
    await db.run(sql`UPDATE outbox SET lease_until = ${Date.now() + 60_000}, lease_token = ${'w1'} WHERE id = ${claimed}`);
    expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-4', action: 'create', emailOutboxId: 'em-4' })).toBe(false);
    expect((await calendarRows('bk-4'))[0]!.payload).toBeNull();
  });
});
