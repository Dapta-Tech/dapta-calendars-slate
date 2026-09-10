import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, isSlotBookable, loadBusyForHost } from './repository';
import {
  createTeamBooking,
  getBookingRescheduleAvailability,
  getTeamAvailability,
  rescheduleBooking,
} from './parity';
import { createEventType, createTeam } from './crud';

/**
 * What a RESCHEDULE means per scheduling method — #129 and #127, which are one
 * question asked twice.
 *
 * #129: `createTeamBooking` assigns a host SET (a `booking_host` row per host
 * for collective / fixed_round_robin) and guards overlap for every one of them.
 * `rescheduleBooking` validated and guarded `booking.host_member_id` alone, so
 * a manage-token holder could POST a move that double-booked a co-host — a move
 * create time would have refused. The Postgres `booking_no_overlap` EXCLUDE does
 * NOT cover it (a co-host conflict is a different tuple), so the app-level guard
 * is the only line, and these are the specs that hold it.
 *
 * #127: the same set, read the other way. The public team route offers the UNION
 * of hosts' free times for round-robin, because create time still gets to pick
 * who takes the slot; a reschedule does not pick again. So the picker offered
 * times the write refused. Fixed here by keeping the assignment and giving the
 * manage picker a booking-scoped read over that same host set.
 */
describe('team reschedule — the assigned host set (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  const attendee = { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' };
  const WINDOW = () => ({ fromMs: Date.now(), toMs: Date.now() + 14 * 86_400_000 });

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  /** A team + team event of the given method, hosted by the given members. */
  async function makeTeamEvent(
    slug: string,
    schedulingType: 'round_robin' | 'collective' | 'fixed_round_robin',
    hosts: Array<{ memberId: string; isFixed?: boolean }>,
  ) {
    const team = await createTeam(db, accountId, { name: slug, slug: `${slug}-team` });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType,
      scheduleId: null,
      teamId: team.value.id,
    });
    if (!ev.ok) throw new Error('event create failed');
    const now = Date.now();
    for (const h of hosts) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${h.memberId}, ${h.isFixed ? 1 : 0}, ${null}, ${100}, ${null}, ${now})`,
      );
    }
    return { teamSlug: `${slug}-team`, slug, eventTypeId: ev.value.id };
  }

  /** What the PUBLIC team route offers (union / intersection per method). */
  async function publicSlots(t: { teamSlug: string; slug: string }): Promise<number[]> {
    const r = await getTeamAvailability(db, { accountCode: 'acme', teamSlug: t.teamSlug, slug: t.slug, ...WINDOW() });
    return (r?.slots ?? []).map((s) => new Date(s).getTime());
  }

  /**
   * Instants BOTH hosts are free at — a collective probe event over the same
   * two hosts, whose availability is by definition their intersection. A
   * round-robin event's own slots are a UNION, so picking a target from them
   * can land on a time only ONE host is free at, and the divergence this suite
   * sets up (organizer busy, other host free) would collapse to "both busy".
   */
  async function bothFreeSlots(probeSlug: string): Promise<number[]> {
    const probe = await makeTeamEvent(probeSlug, 'collective', [
      { memberId: alexId },
      { memberId: jordanId },
    ]);
    return publicSlots(probe);
  }

  /** What the MANAGE picker offers for one existing booking. */
  async function pickerSlots(uid: string, manageToken: string): Promise<number[]> {
    const r = await getBookingRescheduleAvailability(db, { uid, manageToken, ...WINDOW() });
    return (r?.slots ?? []).map((s) => new Date(s).getTime());
  }

  async function book(t: { teamSlug: string; slug: string }, startMs: number) {
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: t.teamSlug,
      slug: t.slug,
      startMs,
      attendee,
    });
    if (!out.ok) throw new Error(`team booking failed: ${out.reason}`);
    return out;
  }

  /**
   * A third host, sharing Jordan's schedule. Two members is one too few to
   * isolate a CO-HOST conflict: with only Alex and Jordan, any booking that is
   * not the co-host's own belongs to the organizer, and the organizer check
   * catches it — which would let the co-host spec pass without the fix.
   */
  async function makeThirdMember(): Promise<{ id: string; handle: string }> {
    const jordan = (await db.get<{ default_schedule_id: string | null }>(
      sql`SELECT default_schedule_id FROM member WHERE id = ${jordanId}`,
    ))!;
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
          VALUES (${id}, ${accountId}, ${'riley-quinn'}, ${'Riley Quinn'}, ${'riley@example.com'},
                  ${'America/New_York'}, ${jordan.default_schedule_id}, ${Date.now()})`,
    );
    return { id, handle: 'riley-quinn' };
  }

  /** Occupy `memberId` at `startMs` with a booking of their own. */
  async function occupy(memberId: string, handle: string, slug: string, startMs: number) {
    await createEventType(db, accountId, memberId, { slug, title: slug, lengthMinutes: 30, scheduleId: null });
    const busy = await createBooking(db, {
      accountCode: 'acme',
      handle,
      slug,
      startMs,
      attendee: { name: 'Other', email: `other-${slug}@example.com`, timeZone: 'America/New_York' },
    });
    if (!busy.ok) throw new Error('could not occupy the host');
    return busy.booking;
  }

  const rowFor = (uid: string) =>
    db.get<{ id: string; start_ms: number; host_member_id: string }>(
      sql`SELECT id, start_ms, host_member_id FROM booking WHERE uid = ${uid}`,
    );

  const hostRowsFor = async (bookingId: string) =>
    (await db.all<{ member_id: string }>(sql`SELECT member_id FROM booking_host WHERE booking_id = ${bookingId}`))
      .map((r) => r.member_id)
      .sort();

  // --- #129: the guard covers every assigned host -------------------------

  it('refuses a collective reschedule onto a CO-HOST’s own conflict', async () => {
    const collab = await makeTeamEvent('collab', 'collective', [{ memberId: alexId }, { memberId: jordanId }]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);
    const target = slots[1]!;

    const row = (await rowFor(booked.uid))!;
    const coHostId = row.host_member_id === alexId ? jordanId : alexId;
    const coHostHandle = coHostId === alexId ? 'alex-rivera' : 'jordan-lee';
    // The co-host — NOT the organizer the reschedule used to check — is busy at
    // the target. Create time refuses this exact overlap; so must the move.
    await occupy(coHostId, coHostHandle, 'cohost-busy', target);

    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(false);
    // The booking stayed where it was — a refused move must not half-apply.
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(slots[0]!);
  });

  it('refuses when the co-host’s conflict is one they attend as a CO-HOST', async () => {
    // The case only the transactional guard can catch: the conflicting booking
    // is held by someone else, and the co-host is on it through `booking_host`.
    // A `host_member_id = ?` check sees nothing here — which is exactly the
    // shape `createTeamBooking`'s guard was written to cover, and the shape the
    // reschedule path was missing.
    const collab = await makeTeamEvent('collab', 'collective', [{ memberId: alexId }, { memberId: jordanId }]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);
    const target = slots[1]!;

    const row = (await rowFor(booked.uid))!;
    const organizerId = row.host_member_id;
    const coHostId = organizerId === alexId ? jordanId : alexId;

    // A THIRD person's booking at the target, with the co-host assigned to it.
    // Nothing about it touches the organizer, so only a guard that reads the
    // whole assigned host set can refuse the move.
    const riley = await makeThirdMember();
    const other = await occupy(riley.id, riley.handle, 'other-meeting', target);
    const otherRow = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${other.uid}`))!;
    expect(otherRow?.id).toBeTruthy();
    await db.run(
      sql`INSERT INTO booking_host (id, booking_id, member_id, is_fixed, created_at)
          VALUES (${randomUUID()}, ${otherRow.id}, ${coHostId}, ${1}, ${Date.now()})`,
    );

    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(false);
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(slots[0]!);
  });

  it('moves a clean collective booking with its WHOLE host set', async () => {
    const collab = await makeTeamEvent('collab', 'collective', [{ memberId: alexId }, { memberId: jordanId }]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);
    const target = slots[1]!;

    const row = (await rowFor(booked.uid))!;
    const assignedBefore = await hostRowsFor(row.id);
    expect(assignedBefore).toEqual([alexId, jordanId].sort());

    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(true);

    // One row, moved — not a second booking.
    const rows = await db.all<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${booked.uid}`);
    expect(rows).toHaveLength(1);
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(target);

    // Every assigned host is still assigned…
    expect(await hostRowsFor(row.id)).toEqual(assignedBefore);
    // …and every one of them is now busy at the NEW time and free at the old,
    // which is what "the booking_host rows moved with it" means for a table
    // that carries membership rather than a time of its own.
    for (const memberId of assignedBefore) {
      const busy = await loadBusyForHost(db, memberId, target, target + 30 * 60_000);
      expect(busy.some((i) => i.start.getTime() === target)).toBe(true);
      const wasBusy = await loadBusyForHost(db, memberId, slots[0]!, slots[0]! + 30 * 60_000);
      expect(wasBusy.some((i) => i.start.getTime() === slots[0]!)).toBe(false);
    }
  });

  // --- #127: the picker and the write agree -------------------------------

  it('round-robin: the picker offers only what the write accepts', async () => {
    const rr = await makeTeamEvent('rr', 'round_robin', [{ memberId: alexId }, { memberId: jordanId }]);
    const slots = await bothFreeSlots('rr-probe');
    const booked = await book(rr, slots[0]!);

    const row = (await rowFor(booked.uid))!;
    const organizerId = row.host_member_id;
    const organizerHandle = organizerId === alexId ? 'alex-rivera' : 'jordan-lee';
    const target = slots[1]!;
    // Make the hosts diverge: the ASSIGNED organizer is busy at the target, the
    // other host is free. This is the state #127 needs — with identical
    // schedules the union and the organizer's own hours coincide and nothing shows.
    await occupy(organizerId, organizerHandle, 'organizer-busy', target);

    // The public route still lists it (round-robin = union: the other host is free)…
    expect(await publicSlots(rr)).toContain(target);
    // …the booking-scoped picker does not, because THIS booking's host cannot take it…
    expect(await pickerSlots(booked.uid, booked.manageToken)).not.toContain(target);
    // …and the write refuses it, which is the 400 the manage page used to show.
    const refused = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(refused.ok).toBe(false);

    // What the picker DOES offer, the write takes — the whole point of #127.
    // Asserted over the offered SET, not just the one slot we then move to: the
    // contract is that the picker never lists a time the write would refuse.
    const offered = await pickerSlots(booked.uid, booked.manageToken);
    expect(offered.length).toBeGreaterThan(0);
    const hostScheduleId =
      (
        await db.get<{ schedule_id: string | null }>(
          sql`SELECT schedule_id FROM event_type_host
              WHERE event_type_id = ${rr.eventTypeId} AND member_id = ${organizerId}`,
        )
      )?.schedule_id ?? null;
    for (const startMs of offered.slice(0, 8)) {
      expect(
        await isSlotBookable(db, {
          eventTypeId: rr.eventTypeId,
          hostMemberId: organizerId,
          hostScheduleId,
          startMs,
          excludeBookingId: row.id,
        }),
      ).toBe(true);
    }
    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: offered[0]!,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(true);
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(offered[0]!);
  });

  it('collective: the picker keeps intersecting, and every slot it lists moves', async () => {
    const collab = await makeTeamEvent('collab', 'collective', [{ memberId: alexId }, { memberId: jordanId }]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);

    const offered = await pickerSlots(booked.uid, booked.manageToken);
    expect(offered.length).toBeGreaterThan(0);
    // Its own instant is not on offer — a move to where it already is has no meaning.
    expect(offered).not.toContain(slots[0]!);
    // A co-host busy at a listed time drops it from the picker, as it does at create.
    await occupy(jordanId, 'jordan-lee', 'jordan-busy', offered[0]!);
    expect(await pickerSlots(booked.uid, booked.manageToken)).not.toContain(offered[0]!);

    const stillOffered = await pickerSlots(booked.uid, booked.manageToken);
    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: stillOffered[0]!,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(true);
  });

  it('answers nothing once the booking is no longer movable', async () => {
    const rr = await makeTeamEvent('rr', 'round_robin', [{ memberId: alexId }, { memberId: jordanId }]);
    const booked = await book(rr, (await publicSlots(rr))[0]!);
    expect((await pickerSlots(booked.uid, booked.manageToken)).length).toBeGreaterThan(0);
    // `rescheduleBooking` answers GONE for anything but `accepted`, so a picker
    // here would offer a list every option of which is already refused.
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${booked.uid}`);
    expect(
      await getBookingRescheduleAvailability(db, {
        uid: booked.uid,
        manageToken: booked.manageToken,
        ...WINDOW(),
      }),
    ).toBeNull();
  });

  it('answers nothing for a bad manage token, exactly as for an unknown uid', async () => {
    const rr = await makeTeamEvent('rr', 'round_robin', [{ memberId: alexId }, { memberId: jordanId }]);
    const booked = await book(rr, (await publicSlots(rr))[0]!);
    expect(await getBookingRescheduleAvailability(db, { uid: booked.uid, manageToken: 'nope', ...WINDOW() })).toBeNull();
    expect(await getBookingRescheduleAvailability(db, { uid: 'no-such-uid', manageToken: booked.manageToken, ...WINDOW() })).toBeNull();
  });
});
