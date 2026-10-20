import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { createEventType, updateEventType } from './crud';
import { applyCalendarTemplates, applySharedFallback } from './calendar-text';

// Both renders are spied on, so a test can make one of them not land.
vi.mock('./calendar-text', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./calendar-text')>();
  return {
    ...mod,
    applyCalendarTemplates: vi.fn(mod.applyCalendarTemplates),
    applySharedFallback: vi.fn(mod.applySharedFallback),
  };
});

/**
 * Taking a seat on a group slot: the slot's text must be the shared one before
 * its calendar event is rewritten for the person joining (`seatTaken`), and a
 * repeated seat is a replay. Its own file, so the renders can be made to fail.
 */
describe('a seat taken on a group slot', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;

  beforeEach(async () => {
    vi.mocked(applyCalendarTemplates).mockClear();
    vi.mocked(applySharedFallback).mockClear();
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
  });

  /** A slot Alice booked while the event had no seats and a personal title; then seats on. */
  async function slotBookedBeforeSeats(): Promise<{ startMs: number; uid: string }> {
    const out = await createEventType(db, accountId, alexId, {
      slug: 'office',
      title: 'Office hours',
      lengthMinutes: 30,
      calendarTitleTemplate: 'Office hours - {{name}}',
      calendarDescriptionTemplate: 'Email {{email}}',
    });
    if (!out.ok) throw new Error('event type failed');
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'office',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const startMs = new Date(a!.slots[0]!.startUtc).getTime();
    const alice = await book(startMs, 'Alice Secret', 'alice@example.com');
    if (!alice.ok) throw new Error('first booking failed');
    await updateEventType(db, accountId, out.value.id, {
      seatsPerTimeSlot: 5,
      calendarTitleTemplate: null,
      calendarDescriptionTemplate: null,
    });
    return { startMs, uid: alice.booking.uid };
  }

  const book = (startMs: number, name: string, email: string) =>
    createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'office',
      startMs,
      attendee: { name, email, timeZone: 'UTC' },
    });

  const stored = async (uid: string) =>
    (await db.get<{ title: string; calendar_description: string | null }>(
      sql`SELECT title, calendar_description FROM booking WHERE uid = ${uid}`,
    ))!;

  it('when the shared render does not land, the slot is reset to the event name before the event is rewritten', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    expect((await stored(uid)).title).toBe('Office hours - Alice Secret');
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    const bob = await book(startMs, 'Bob Other', 'bob@example.com');
    expect(bob).toMatchObject({ ok: true, seatTaken: true, booking: { title: 'Office hours', calendarDescription: null } });
    expect(applySharedFallback).toHaveBeenCalledTimes(1);
    expect(await stored(uid)).toEqual({ title: 'Office hours', calendar_description: '' });
  });

  it('when even the reset fails, the event is not rewritten for the new seat-taker', async () => {
    const { startMs } = await slotBookedBeforeSeats();
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    vi.mocked(applySharedFallback).mockResolvedValueOnce(null);
    const bob = await book(startMs, 'Bob Other', 'bob@example.com');
    if (!bob.ok) throw new Error('seat failed');
    expect(bob.seatTaken).toBeUndefined();
    expect(bob.booking).toMatchObject({ title: 'Office hours', calendarDescription: null });
  });

  it('the reset never writes over a booking that moved meanwhile', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const row = (await db.get<{ id: string; title: string }>(sql`SELECT id, title FROM booking WHERE uid = ${uid}`))!;
    // Seen at one time, but the booking is now somewhere else.
    expect(await applySharedFallback(db, { id: row.id, startMs: startMs + 1, endMs: startMs + 30 * 60_000 }, 'Office hours')).toBeNull();
    expect((await stored(uid)).title).toBe(row.title);
    expect(
      await applySharedFallback(db, { id: row.id, startMs, endMs: startMs + 30 * 60_000 }, 'Office hours'),
    ).toEqual({ title: 'Office hours' });
  });

  it('a repeated seat is a replay: no second row, no seat spent, no rewrite, nobody else text', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const first = await book(startMs, 'Bob Other', 'bob@example.com');
    expect(first).toMatchObject({ ok: true, seatTaken: true });
    const again = await book(startMs, 'Bob Other', ' BOB@example.com ');
    expect(again).toMatchObject({ ok: true, deduplicated: true, manageToken: '' });
    if (!again.ok) throw new Error('replay failed');
    expect(again.seatTaken).toBeUndefined();
    // Someone typing the first booker's address learns nothing of her text.
    const posing = await book(startMs, 'Mallory', 'alice@example.com');
    expect(posing).toMatchObject({ ok: true, deduplicated: true, booking: { title: 'Office hours', calendarDescription: null } });
    const count = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
    );
    expect(Number(count!.n)).toBe(2);
  });
});
