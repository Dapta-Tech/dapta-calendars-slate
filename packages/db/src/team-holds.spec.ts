import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createTeamBooking, getTeamAvailability, insertHoldGuarded } from './parity';
import { createEventType, createTeam } from './crud';

/**
 * A soft hold on one of a host's own events (a booking page's pick, or the MCP
 * hold tool) keeps that host out of team assignment at that time, as it already
 * keeps the time out of the team's slot list. Before, round-robin could assign
 * the held host, and the holder's own booking then answered SLOT_TAKEN.
 * Collective and fixed hosts are never assigned around: a held one makes the
 * time unbookable. Runs on SQLite, and on Postgres too when DATABASE_URL names one
 * (its own account and members, since that database is shared between files).
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const engines: Array<[string, string]> = [['SQLite', 'file::memory:'], ...(isPg ? [['Postgres', url] as [string, string]] : [])];

describe.each(engines)('team assignment skips a held host (%s)', (_engine, dbUrl) => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const accountCode = `holds-${tag}`;
  let accountId: string;
  let alex: string;
  let bea: string;
  let alexOwn: string;
  const HALF_HOUR = 30 * 60_000;

  async function member(handle: string): Promise<string> {
    const id = randomUUID();
    const scheduleId = randomUUID();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
          VALUES (${id}, ${accountId}, ${handle}, ${handle}, ${`${handle}@example.test`}, 'UTC', ${scheduleId}, ${now})`,
    );
    await db.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES (${scheduleId}, ${accountId}, ${id}, 'Hours', 'UTC', ${now})`);
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([0, 1, 2, 3, 4, 5, 6])}, '08:00', '20:00', ${null})`,
    );
    return id;
  }

  /** A team event with these hosts; Alex outranks Bea, so round-robin picks Alex whenever both are free. */
  async function teamEvent(method: 'round_robin' | 'collective' | 'fixed_round_robin', fixedAlex = false) {
    const slug = `${method.replace(/_/g, '-')}-${randomUUID().slice(0, 6)}`;
    const team = await createTeam(db, accountId, { name: slug, slug: `${slug}-team` });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType: method,
      scheduleId: null,
      teamId: team.value.id,
      minimumBookingNotice: 0,
    });
    if (!ev.ok) throw new Error('event create failed');
    for (const [memberId, priority, fixed] of [
      [alex, 2, fixedAlex],
      [bea, 1, false],
    ] as const) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, ${fixed ? 1 : 0}, ${priority}, ${100}, ${null}, ${Date.now()})`,
      );
    }
    const slots = (await getTeamAvailability(db, {
      accountCode,
      teamSlug: `${slug}-team`,
      slug,
      fromMs: Date.now() + 86_400_000,
      toMs: Date.now() + 8 * 86_400_000,
    }))!.slots.map((s) => new Date(s).getTime());
    const book = (startMs: number, email: string) =>
      createTeamBooking(db, {
        accountCode,
        teamSlug: `${slug}-team`,
        slug,
        startMs,
        attendee: { name: 'Team Invitee', email, timeZone: 'UTC' },
      });
    return { slots, book };
  }

  /** Alex's own soft hold on their personal event, as the booking page or hold_slot places it. */
  const hold = (memberId: string, startMs: number, releaseAtMs = Date.now() + 10 * 60_000) =>
    insertHoldGuarded(db, {
      accountId,
      eventTypeId: alexOwn,
      memberId,
      startMs,
      endMs: startMs + HALF_HOUR,
      uid: randomUUID(),
      releaseAtMs,
      now: Date.now(),
    });

  beforeAll(async () => {
    db = await createDb(dbUrl);
    await migrate(db);
    accountId = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, onboarding_completed_at, created_at) VALUES (${accountId}, ${accountCode}, 'Holds Co', ${Date.now()}, ${Date.now()})`,
    );
    alex = await member(`alex-${tag}`);
    bea = await member(`bea-${tag}`);
    const own = await createEventType(db, accountId, alex, { slug: 'own', title: 'Own', lengthMinutes: 30, scheduleId: null });
    if (!own.ok) throw new Error('personal event create failed');
    alexOwn = own.value.id;
  });

  afterAll(async () => {
    await db.close();
  });

  it('round-robin assigns the free host when the preferred one is held, and Alex again once the hold has lapsed', async () => {
    const rr = await teamEvent('round_robin');
    const [free, held, lapsed] = [rr.slots[2]!, rr.slots[6]!, rr.slots[10]!];
    // Control: with nothing held, Alex (higher priority) is the pick.
    const control = await rr.book(free, 'control@example.org');
    expect(control.ok && control.hostMemberId).toBe(alex);

    expect(await hold(alex, held)).toBe('ok');
    const around = await rr.book(held, 'around@example.org');
    expect(around.ok && around.hostMemberId).toBe(bea);

    expect(await hold(alex, lapsed, Date.now() - 1)).toBe('ok');
    const after = await rr.book(lapsed, 'lapsed@example.org');
    expect(after.ok && after.hostMemberId).toBe(alex);
  });

  it('round-robin with every host held is SLOT_TAKEN and writes nothing', async () => {
    const rr = await teamEvent('round_robin');
    const at = rr.slots[14]!;
    expect(await hold(alex, at)).toBe('ok');
    expect(await hold(bea, at)).toBe('ok');
    const out = await rr.book(at, 'nobody@example.org');
    expect(out).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    const n = await db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM booking WHERE account_id = ${accountId} AND start_ms = ${at}`);
    expect(Number(n!.n)).toBe(0);
  });

  it('collective: one held host makes the time SLOT_TAKEN, never a booking without them', async () => {
    const all = await teamEvent('collective');
    const at = all.slots[18]!;
    expect(await hold(alex, at)).toBe('ok');
    expect(await all.book(at, 'collective@example.org')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });

  it('fixed round-robin: a held fixed host makes the time SLOT_TAKEN, never assigned around; a held rotating host is left out', async () => {
    const fixed = await teamEvent('fixed_round_robin', true);
    const at = fixed.slots[22]!;
    expect(await hold(alex, at)).toBe('ok');
    expect(await fixed.book(at, 'fixed@example.org')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    // A held rotating host is treated like a busy one: left out, the fixed host still attends.
    const other = fixed.slots[26]!;
    expect(await hold(bea, other)).toBe('ok');
    const out = await fixed.book(other, 'rotating@example.org');
    expect(out.ok && out.hostMemberId).toBe(alex);
    if (!out.ok) return;
    const beaSeat = await db.get<{ id: string }>(
      sql`SELECT bh.id FROM booking_host bh JOIN booking b ON b.id = bh.booking_id WHERE b.uid = ${out.uid} AND bh.member_id = ${bea}`,
    );
    expect(beaSeat).toBeUndefined();
  });
});
