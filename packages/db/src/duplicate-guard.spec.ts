import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability } from './parity';
import { createEventType, createTeam, getEventTypeById, updateEventType } from './crud';
import { hasUpcomingBookingForEmail, normalizeAttendeeEmail } from './duplicate-guard';

/**
 * Duplicate-booking guard (#69, unit AB1 / #95).
 *
 * A per-event-type switch, OFF by default, that stops one normalized email
 * holding more than one UPCOMING booking on that event type. Both public write
 * paths carry it — `createBooking` (personal) and `createTeamBooking` (team) —
 * and the two live in different files, so every behaviour is asserted on BOTH.
 *
 * It is not a security control (no email is verified anywhere in this product);
 * these tests pin the product behaviour a host is promised.
 */
describe('duplicate-booking guard (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  // --- Fixtures -----------------------------------------------------------

  /** A personal event on Alex, with the guard in the given state. */
  async function makePersonalEvent(
    slug: string,
    opts: { guard: boolean; seats?: number } = { guard: true },
  ) {
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      preventDuplicateBookings: opts.guard,
      seatsPerTimeSlot: opts.seats ?? null,
    });
    if (!ev.ok) throw new Error('event create failed');
    return ev.value.id;
  }

  async function makeTeamEvent(slug: string, opts: { guard: boolean }) {
    const team = await createTeam(db, accountId, { name: slug, slug: `${slug}-team` });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType: 'round_robin',
      scheduleId: null,
      teamId: team.value.id,
      preventDuplicateBookings: opts.guard,
    });
    if (!ev.ok) throw new Error('event create failed');
    const now = Date.now();
    for (const memberId of [alexId, jordanId]) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, 0, NULL, 100, NULL, ${now})`,
      );
    }
    return { teamSlug: `${slug}-team`, slug };
  }

  /** The event's own offered slots — the guard must never be the reason a
   *  booking fails for want of availability. */
  async function personalSlots(slug: string): Promise<number[]> {
    const r = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return (r?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  async function teamSlots(t: { teamSlug: string; slug: string }): Promise<number[]> {
    const r = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: t.teamSlug,
      slug: t.slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return (r?.slots ?? []).map((s) => new Date(s).getTime());
  }

  const bookPersonal = (slug: string, startMs: number, email: string, extra = {}) =>
    createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs,
      attendee: { name: 'Pat', email, timeZone: 'America/New_York' },
      ...extra,
    });

  const bookTeam = (t: { teamSlug: string; slug: string }, startMs: number, email: string, extra = {}) =>
    createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: t.teamSlug,
      slug: t.slug,
      startMs,
      attendee: { name: 'Pat', email, timeZone: 'America/New_York' },
      ...extra,
    });

  // --- The normalizer -----------------------------------------------------

  it('is account-scoped — the right event type under the wrong account matches nothing', async () => {
    // The helper is exported from @slate/db, so it must not let a caller
    // holding only an event-type id read across tenants (invariant 4).
    const slug = 'scoped';
    const eventTypeId = await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);
    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);

    expect(await hasUpcomingBookingForEmail(db, accountId, eventTypeId, 'pat@example.com')).toBe(true);
    expect(
      await hasUpcomingBookingForEmail(db, randomUUID(), eventTypeId, 'pat@example.com'),
    ).toBe(false);
  });

  it('normalizes case and surrounding whitespace, and keeps +tags intact', () => {
    expect(normalizeAttendeeEmail('  ALEX@Example.com ')).toBe('alex@example.com');
    // #69: most providers treat a plus-tag as a distinct mailbox, so stripping
    // it would eventually block a legitimately different person.
    expect(normalizeAttendeeEmail('alex+tag@example.com')).toBe('alex+tag@example.com');
  });

  // --- Off by default -----------------------------------------------------

  it('is OFF on a new event type, so a second booking from one email lands', async () => {
    const slug = 'off-by-default';
    await makePersonalEvent(slug, { guard: false });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookPersonal(slug, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  it('reads as OFF on a row that predates the column (deploy changes nothing)', async () => {
    const slug = 'legacy-row';
    const id = await makePersonalEvent(slug, { guard: false });
    // Simulate an event type written before this feature existed: the column's
    // DEFAULT 0 is the whole compatibility story.
    await db.run(sql`UPDATE event_type SET prevent_duplicate_bookings = 0 WHERE id = ${id}`);
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookPersonal(slug, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  it('survives a round-trip through the event-type editor', async () => {
    const slug = 'round-trip';
    const id = await makePersonalEvent(slug, { guard: true });
    expect((await getEventTypeById(db, accountId, id))!.preventDuplicateBookings).toBe(true);

    // A patch that does not mention the field must not clear it.
    await updateEventType(db, accountId, id, { title: 'Renamed' });
    expect((await getEventTypeById(db, accountId, id))!.preventDuplicateBookings).toBe(true);

    await updateEventType(db, accountId, id, { preventDuplicateBookings: false });
    expect((await getEventTypeById(db, accountId, id))!.preventDuplicateBookings).toBe(false);
  });

  // --- On: the personal write path ---------------------------------------

  it('blocks a second upcoming booking from the same email — personal path', async () => {
    const slug = 'guarded';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    const second = await bookPersonal(slug, slots[1]!, 'pat@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
  });

  it('matches on case and whitespace, but not across a +tag — personal path', async () => {
    const slug = 'guarded-norm';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);

    const cased = await bookPersonal(slug, slots[1]!, '  PAT@Example.com ');
    expect(cased.ok).toBe(false);
    if (!cased.ok) expect(cased.reason).toBe('DUPLICATE_BOOKING');

    // A plus-tag is a different person as far as this guard is concerned.
    expect((await bookPersonal(slug, slots[1]!, 'pat+work@example.com')).ok).toBe(true);
  });

  it('does not block a different email', async () => {
    const slug = 'guarded-other';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookPersonal(slug, slots[1]!, 'sam@example.com')).ok).toBe(true);
  });

  it('is scoped to ONE event type — a booking on another event does not block', async () => {
    await makePersonalEvent('guarded-a', { guard: true });
    await makePersonalEvent('guarded-b', { guard: true });
    const a = await personalSlots('guarded-a');
    const b = await personalSlots('guarded-b');

    expect((await bookPersonal('guarded-a', a[0]!, 'pat@example.com')).ok).toBe(true);
    // A DIFFERENT instant: both events belong to the same host, so reusing
    // a[0] would be refused by the double-booking guard and prove nothing
    // about the duplicate guard's scope.
    const other = b.find((s) => s !== a[0])!;
    expect((await bookPersonal('guarded-b', other, 'pat@example.com')).ok).toBe(true);
  });

  // --- What counts as "upcoming" -----------------------------------------

  it('counts a PENDING booking', async () => {
    const slug = 'guarded-pending';
    const id = await makePersonalEvent(slug, { guard: true });
    await updateEventType(db, accountId, id, { requiresConfirmation: true });
    const slots = await personalSlots(slug);

    const first = await bookPersonal(slug, slots[0]!, 'pat@example.com');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.booking.status).toBe('pending');

    const second = await bookPersonal(slug, slots[1]!, 'pat@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
  });

  it('does NOT count a cancelled booking — cancelling frees the slot', async () => {
    const slug = 'guarded-cancel';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    const first = await bookPersonal(slug, slots[0]!, 'pat@example.com');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${first.booking.uid}`);

    expect((await bookPersonal(slug, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  it('does NOT count a booking that has already ended — a returning invitee rebooks', async () => {
    const slug = 'guarded-past';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    const first = await bookPersonal(slug, slots[0]!, 'pat@example.com');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Push the first booking wholly into the past.
    const past = Date.now() - 86_400_000;
    await db.run(
      sql`UPDATE booking SET start_ms = ${past}, end_ms = ${past + 1_800_000} WHERE uid = ${first.booking.uid}`,
    );

    expect((await bookPersonal(slug, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  // --- Exemptions ---------------------------------------------------------

  it('exempts a host booking on behalf', async () => {
    const slug = 'guarded-onbehalf';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookPersonal(slug, slots[1]!, 'pat@example.com', { onBehalf: true })).ok).toBe(true);
  });

  it('exempts an API-key write even when it reports onBehalf: false', async () => {
    // The v2 compatibility surface is exactly this shape, which is why the
    // guard reads a flag of its own rather than inferring from `onBehalf`.
    const slug = 'guarded-apikey';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    const viaKey = await bookPersonal(slug, slots[1]!, 'pat@example.com', {
      onBehalf: false,
      apiKeyWrite: true,
    });
    expect(viaKey.ok).toBe(true);
  });

  // --- Idempotency and group seats ---------------------------------------

  it('lets an idempotent replay through instead of answering DUPLICATE_BOOKING', async () => {
    const slug = 'guarded-idem';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    const key = `idem-${randomUUID()}`;
    const first = await bookPersonal(slug, slots[0]!, 'pat@example.com', { idempotencyKey: key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await bookPersonal(slug, slots[0]!, 'pat@example.com', { idempotencyKey: key });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.deduplicated).toBe(true);
      expect(replay.booking.uid).toBe(first.booking.uid);
    }
  });

  it('blocks a second SEAT on a group event, not just a second booking row', async () => {
    const slug = 'guarded-group';
    await makePersonalEvent(slug, { guard: true, seats: 3 });
    const slots = await personalSlots(slug);

    expect((await bookPersonal(slug, slots[0]!, 'pat@example.com')).ok).toBe(true);
    // Same slot, same email: without the guard this would quietly add a seat.
    const second = await bookPersonal(slug, slots[0]!, 'pat@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
    // Someone else still gets a seat.
    expect((await bookPersonal(slug, slots[0]!, 'sam@example.com')).ok).toBe(true);
  });

  // --- The team write path ------------------------------------------------

  it('is OFF by default on a team event, so a second booking lands', async () => {
    const t = await makeTeamEvent('team-off', { guard: false });
    const slots = await teamSlots(t);

    expect((await bookTeam(t, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookTeam(t, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  it('blocks a second upcoming booking from the same email — TEAM path', async () => {
    const t = await makeTeamEvent('team-on', { guard: true });
    const slots = await teamSlots(t);

    expect((await bookTeam(t, slots[0]!, 'pat@example.com')).ok).toBe(true);
    const second = await bookTeam(t, slots[1]!, 'pat@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
  });

  it('blocks regardless of WHICH host round-robin assigned — TEAM path', async () => {
    // The guard is scoped to the event type, not to the host, so a round-robin
    // rotation cannot be used to slip a second booking past it.
    const t = await makeTeamEvent('team-rr', { guard: true });
    const slots = await teamSlots(t);

    const first = await bookTeam(t, slots[0]!, 'pat@example.com');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect([alexId, jordanId]).toContain(first.hostMemberId);

    const second = await bookTeam(t, slots[1]!, 'PAT@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
  });

  it('exempts an API-key write — TEAM path', async () => {
    const t = await makeTeamEvent('team-apikey', { guard: true });
    const slots = await teamSlots(t);

    expect((await bookTeam(t, slots[0]!, 'pat@example.com')).ok).toBe(true);
    expect((await bookTeam(t, slots[1]!, 'pat@example.com', { apiKeyWrite: true })).ok).toBe(true);
  });

  it('does not count a cancelled team booking — TEAM path', async () => {
    const t = await makeTeamEvent('team-cancel', { guard: true });
    const slots = await teamSlots(t);

    const first = await bookTeam(t, slots[0]!, 'pat@example.com');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${first.uid}`);

    expect((await bookTeam(t, slots[1]!, 'pat@example.com')).ok).toBe(true);
  });

  // --- The normalized column ---------------------------------------------

  it('writes email_normalized on the attendee row, and still matches when it is NULL', async () => {
    const slug = 'guarded-column';
    await makePersonalEvent(slug, { guard: true });
    const slots = await personalSlots(slug);

    const first = await bookPersonal(slug, slots[0]!, '  PAT@Example.com ');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const row = await db.get<{ email_normalized: string | null }>(
      sql`SELECT a.email_normalized FROM booking_attendee a
          JOIN booking b ON b.id = a.booking_id WHERE b.uid = ${first.booking.uid}`,
    );
    expect(row?.email_normalized).toBe('pat@example.com');

    // A row written by an older deployment (migration applied, new API not yet
    // live) carries NULL. The read coalesces, so it must still block.
    await db.run(sql`UPDATE booking_attendee SET email_normalized = NULL`);
    const second = await bookPersonal(slug, slots[1]!, 'pat@example.com');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');
  });
});
