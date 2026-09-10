import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, loadBusyForHost } from './repository';
import {
  createTeamBooking,
  getBookingRescheduleAvailability,
  getTeamAvailability,
  rescheduleBooking,
} from './parity';
import { createEventType, createTeam } from './crud';

/**
 * The Postgres half of `team-reschedule-hosts.spec.ts` (#129 / #127).
 *
 * Postgres is the source of truth (invariant 1), and this path is exactly where
 * that matters most: the `booking_no_overlap` EXCLUDE constraint is defined on
 * the booking's own `host_member_id`, so a CO-HOST conflict is a different
 * tuple and the database will NOT stop it. The app-level guard inside the
 * reschedule transaction is the only line here, and it has to hold on the
 * dialect production runs. Skipped on the SQLite default.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('team reschedule — the assigned host set (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;
  // Unique per run: this database is not recreated between runs, so fixed slugs
  // would collide with the rows a previous run left behind.
  const tag = randomUUID().slice(0, 8);

  const attendee = { name: 'Sam', email: `sam-${tag}@example.com`, timeZone: 'America/New_York' };
  const WINDOW = () => ({ fromMs: Date.now(), toMs: Date.now() + 14 * 86_400_000 });

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed ONLY if the demo account is missing — `seed()` deletes and re-inserts
    // it wholesale, and several spec files share one Postgres.
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function makeTeamEvent(
    name: string,
    schedulingType: 'round_robin' | 'collective',
    hosts: string[],
  ) {
    const slug = `${name}-${tag}`;
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
    for (const memberId of hosts) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, ${0}, ${null}, ${100}, ${null}, ${Date.now()})`,
      );
    }
    return { teamSlug: `${slug}-team`, slug, eventTypeId: ev.value.id };
  }

  async function publicSlots(t: { teamSlug: string; slug: string }): Promise<number[]> {
    const r = await getTeamAvailability(db, { accountCode: 'acme', teamSlug: t.teamSlug, slug: t.slug, ...WINDOW() });
    return (r?.slots ?? []).map((s) => new Date(s).getTime());
  }

  /**
   * Instants BOTH hosts are free at — a collective probe over the same two
   * hosts, whose availability is their intersection. A round-robin event's own
   * slots are a UNION, so a target taken from them can be a time only one host
   * is free at, and this database is shared with every other `.pg` spec file:
   * whatever they booked is real busy time here.
   */
  async function bothFreeSlots(name: string): Promise<number[]> {
    return publicSlots(await makeTeamEvent(name, 'collective', [alexId, jordanId]));
  }

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

  async function occupy(memberId: string, handle: string, name: string, startMs: number) {
    const slug = `${name}-${tag}`;
    await createEventType(db, accountId, memberId, { slug, title: slug, lengthMinutes: 30, scheduleId: null });
    const busy = await createBooking(db, {
      accountCode: 'acme',
      handle,
      slug,
      startMs,
      attendee: { name: 'Other', email: `other-${slug}@example.com`, timeZone: 'America/New_York' },
    });
    if (!busy.ok) throw new Error(`could not occupy the host: ${busy.reason}`);
    return busy.booking;
  }

  const rowFor = (uid: string) =>
    db.get<{ id: string; start_ms: number; host_member_id: string }>(
      sql`SELECT id, start_ms, host_member_id FROM booking WHERE uid = ${uid}`,
    );

  it('refuses a collective reschedule that would double-book a co-host', async () => {
    const collab = await makeTeamEvent('pg-collab-refuse', 'collective', [alexId, jordanId]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);
    const target = slots[1]!;

    const row = (await rowFor(booked.uid))!;
    const coHostId = row.host_member_id === alexId ? jordanId : alexId;
    const coHostHandle = coHostId === alexId ? 'alex-rivera' : 'jordan-lee';
    await occupy(coHostId, coHostHandle, 'pg-cohost-busy', target);

    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(false);
    // The EXCLUDE constraint could not have stopped this — the co-host's
    // conflict is a different tuple — so this is the app guard, on Postgres.
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(slots[0]!);
  });

  it('moves a clean collective booking with its whole host set', async () => {
    const collab = await makeTeamEvent('pg-collab-move', 'collective', [alexId, jordanId]);
    const slots = await publicSlots(collab);
    const booked = await book(collab, slots[0]!);
    const target = slots[1]!;
    const row = (await rowFor(booked.uid))!;

    const assigned = (
      await db.all<{ member_id: string }>(sql`SELECT member_id FROM booking_host WHERE booking_id = ${row.id}`)
    )
      .map((r) => r.member_id)
      .sort();
    expect(assigned).toEqual([alexId, jordanId].sort());

    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: target,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(true);
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(target);

    const after = (
      await db.all<{ member_id: string }>(sql`SELECT member_id FROM booking_host WHERE booking_id = ${row.id}`)
    )
      .map((r) => r.member_id)
      .sort();
    expect(after).toEqual(assigned);
    for (const memberId of assigned) {
      const busy = await loadBusyForHost(db, memberId, target, target + 30 * 60_000);
      expect(busy.some((i) => i.start.getTime() === target)).toBe(true);
    }
  });

  it('round-robin: the picker offers only what the write accepts', async () => {
    const rr = await makeTeamEvent('pg-rr', 'round_robin', [alexId, jordanId]);
    const slots = await bothFreeSlots('pg-rr-probe');
    const booked = await book(rr, slots[0]!);
    const row = (await rowFor(booked.uid))!;
    const organizerHandle = row.host_member_id === alexId ? 'alex-rivera' : 'jordan-lee';
    const target = slots[1]!;
    await occupy(row.host_member_id, organizerHandle, 'pg-organizer-busy', target);

    // Union still lists it; this booking's own host cannot take it.
    expect(await publicSlots(rr)).toContain(target);
    expect(await pickerSlots(booked.uid, booked.manageToken)).not.toContain(target);

    const offered = await pickerSlots(booked.uid, booked.manageToken);
    expect(offered.length).toBeGreaterThan(0);
    const moved = await rescheduleBooking(db, {
      uid: booked.uid,
      newStartMs: offered[0]!,
      manageToken: booked.manageToken,
    });
    expect(moved.ok).toBe(true);
    expect(Number((await rowFor(booked.uid))!.start_ms)).toBe(offered[0]!);
  });
});
