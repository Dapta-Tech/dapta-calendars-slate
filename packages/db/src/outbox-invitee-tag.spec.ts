import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import {
  enqueueOutbox,
  findCalendarChangeForInviteeEmail,
  hasReinviteFor,
  listOutbox,
  markOutboxDone,
  readCalendarChangeMark,
  skipQueuedOutboxRow,
  tagCalendarChangeWithInviteeEmail,
  writeCalendarChangeMark,
} from './outbox';
import { hasPendingCalendarJob } from './calendar-refs';

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

/**
 * What a calendar change records about the invitee email it counted on, and
 * how the job that has the provider invite after all finds it.
 */
describe('the calendar change mark', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
  });

  it('finds the change an email marked, keeps its flags, and never takes a reinvite row for it', async () => {
    const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-5', now: 100 });
    await tagCalendarChangeWithInviteeEmail(db, { bookingUid: 'bk-5', action: 'create', emailOutboxId: 'em-5' });
    await enqueueOutbox(db, {
      kind: 'calendar',
      action: 'reinvite',
      bookingUid: 'bk-5',
      payload: JSON.stringify({ inviteeEmailId: 'em-5' }),
    });
    expect(await findCalendarChangeForInviteeEmail(db, 'bk-5', 'em-5')).toEqual({
      id: create,
      action: 'create',
      status: 'pending',
      mark: { inviteeEmailId: 'em-5' },
    });
    await writeCalendarChangeMark(db, create, { inviteeEmailId: 'em-5', providerMuted: true });
    expect((await findCalendarChangeForInviteeEmail(db, 'bk-5', 'em-5'))!.mark).toEqual({
      inviteeEmailId: 'em-5',
      providerMuted: true,
    });
    // Another email, another booking: nothing.
    expect(await findCalendarChangeForInviteeEmail(db, 'bk-5', 'em-6')).toBeNull();
    expect(await findCalendarChangeForInviteeEmail(db, 'bk-other', 'em-5')).toBeNull();
  });

  it('reads only a well-formed mark', () => {
    expect(readCalendarChangeMark(null)).toBeNull();
    expect(readCalendarChangeMark('not json')).toBeNull();
    expect(readCalendarChangeMark(JSON.stringify({ providerMuted: true }))).toBeNull();
    expect(readCalendarChangeMark(JSON.stringify({ inviteeEmailId: 'em-7', providerMuted: 'yes' }))).toEqual({
      inviteeEmailId: 'em-7',
    });
    expect(readCalendarChangeMark(JSON.stringify({ inviteeEmailId: 'em-7', reinvited: true }))).toEqual({
      inviteeEmailId: 'em-7',
      reinvited: true,
    });
    expect(
      readCalendarChangeMark(JSON.stringify({ inviteeEmailId: 'em-7', emailWaits: 2, guestRemoved: true })),
    ).toEqual({ inviteeEmailId: 'em-7', emailWaits: 2, guestRemoved: true });
    expect(readCalendarChangeMark(JSON.stringify({ inviteeEmailId: 'em-7', providerMuted: true, organizerMoved: true }))).toEqual({
      inviteeEmailId: 'em-7',
      providerMuted: true,
      organizerMoved: true,
    });
    expect(readCalendarChangeMark(JSON.stringify({ inviteeEmailId: 'em-7', emailWaits: -1 }))).toEqual({
      inviteeEmailId: 'em-7',
    });
  });

  it('knows a reinvite already queued for an email, and only for that email', async () => {
    expect(await hasReinviteFor(db, 'bk-9', 'em-9')).toBe(false);
    await enqueueOutbox(db, { kind: 'calendar', action: 'reinvite', bookingUid: 'bk-9', payload: JSON.stringify({ inviteeEmailId: 'em-9' }) });
    expect(await hasReinviteFor(db, 'bk-9', 'em-9')).toBe(true);
    expect(await hasReinviteFor(db, 'bk-9', 'em-90')).toBe(false);
  });

  it('takes back a queued row, never one being sent or already finished', async () => {
    const queued = await enqueueOutbox(db, { kind: 'email', action: 'cancellation', bookingUid: 'bk-10' });
    expect(await skipQueuedOutboxRow(db, queued, 'superseded')).toBe(true);
    const row = (await listOutbox(db, { bookingUid: 'bk-10' }))[0]!;
    expect([row.status, row.lastError]).toEqual(['skipped', 'superseded']);
    const leased = await enqueueOutbox(db, { kind: 'email', action: 'cancellation', bookingUid: 'bk-11' });
    await db.run(sql`UPDATE outbox SET lease_until = ${Date.now() + 60_000}, lease_token = ${'w1'} WHERE id = ${leased}`);
    expect(await skipQueuedOutboxRow(db, leased, 'superseded')).toBe(false);
    const sent = await enqueueOutbox(db, { kind: 'email', action: 'cancellation', bookingUid: 'bk-12' });
    await markOutboxDone(db, sent);
    expect(await skipQueuedOutboxRow(db, sent, 'superseded')).toBe(false);
  });

  it('a pending reinvite is not a write-out an email waits on for its link', async () => {
    await enqueueOutbox(db, { kind: 'calendar', action: 'reinvite', bookingUid: 'bk-8', payload: '{}' });
    expect(await hasPendingCalendarJob(db, 'bk-8')).toBe(false);
    await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-8' });
    expect(await hasPendingCalendarJob(db, 'bk-8')).toBe(true);
  });
});
