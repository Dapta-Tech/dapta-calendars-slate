import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BusyInterval, CalendarProvider, CalendarSummary, ConnectionHealth, CreatedEvent } from '@slate/calendar';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createBooking, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability, insertHoldGuarded } from './parity';
import { rescheduleBookingV2 } from './v2-pilot';
import { createEventType, createTeam } from './crud';

/**
 * A connected calendar whose busy read first runs `onRead`: the window in which
 * a booking has done its checks but not yet its locked write (team host
 * selection, the personal create path and a move all read the calendar there).
 * A hold placed from `onRead` is a hold that commits in exactly that window.
 */
class RacingCalendar implements CalendarProvider {
  readonly enabled = true;
  constructor(private readonly onRead: () => Promise<void>) {}
  async listBusy(): Promise<BusyInterval[]> {
    await this.onRead();
    return [];
  }
  createEvent(): Promise<CreatedEvent> {
    return Promise.reject(new Error('not used'));
  }
  updateEvent(): Promise<CreatedEvent> {
    return Promise.reject(new Error('not used'));
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true });
  }
}

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
    const book = (startMs: number, email: string, calendar?: CalendarProvider) =>
      createTeamBooking(
        db,
        {
          accountCode,
          teamSlug: `${slug}-team`,
          slug,
          startMs,
          attendee: { name: 'Team Invitee', email, timeZone: 'UTC' },
        },
        calendar,
      );
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

  /** A booking that makes `memberId` busy at `startMs`, as any accepted meeting does. */
  async function busy(memberId: string, startMs: number) {
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
          VALUES (${randomUUID()}, ${accountId}, ${randomUUID()}, ${alexOwn}, ${memberId}, 'Busy', ${startMs}, ${startMs + HALF_HOUR}, 'accepted', ${null}, ${Date.now()}, ${Date.now()})`,
    );
  }

  /** What a team booking came to: the hosts it assigned (sorted), or why it was refused. */
  async function outcome(out: Awaited<ReturnType<typeof createTeamBooking>>) {
    if (!out.ok) return out.reason;
    const rows = await db.all<{ member_id: string }>(
      sql`SELECT b.host_member_id AS member_id FROM booking b WHERE b.uid = ${out.uid}
          UNION SELECT bh.member_id FROM booking_host bh JOIN booking b ON b.id = bh.booking_id WHERE b.uid = ${out.uid}`,
    );
    return rows.map((r) => (r.member_id === alex ? 'alex' : r.member_id === bea ? 'bea' : r.member_id)).sort();
  }

  /** Alex's open times right now (bookings and holds from earlier cases subtracted). */
  const alexFree = async () =>
    (await getAvailability(db, { accountCode, handle: `alex-${tag}`, slug: 'own', fromMs: Date.now() + 86_400_000, toMs: Date.now() + 8 * 86_400_000 }))!.slots.map((x) =>
      new Date(x.startUtc).getTime(),
    );

  /** Earlier cases' holds out of the way: a host takes at most ten at a time. */
  const clearHolds = () => db.run(sql`DELETE FROM slot_reservation WHERE account_id = ${accountId}`);

  /** One hold placed by the first calendar read only. */
  const racing = (memberId: string, startMs: number) => {
    let fired = false;
    return new RacingCalendar(async () => {
      if (fired) return;
      fired = true;
      expect(await hold(memberId, startMs)).toBe('ok');
    });
  };

  /** A personal booking on Alex's own event, as the REST routes make it unless `refuseHeld` is set. */
  const bookOwn = (startMs: number, email: string, opts: { refuseHeld?: boolean; reservationUid?: string } = {}, calendar?: CalendarProvider) =>
    createBooking(
      db,
      { accountCode, handle: `alex-${tag}`, slug: 'own', startMs, attendee: { name: 'Own Invitee', email, timeZone: 'UTC' }, ...opts },
      calendar,
    );

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
    // Alex's calendar is conflict-checked, so every booking path reads it (see RacingCalendar).
    await db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${alex}, 'google', ${`cal-${tag}`}, 0, 1, ${Date.now()})`,
    );
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

  it('a held host is treated exactly like a booked host, in every scheduling method', async () => {
    const cases = [
      { method: 'round_robin', fixedAlex: false, who: () => alex, at: [30, 32] },
      { method: 'collective', fixedAlex: false, who: () => alex, at: [34, 36] },
      { method: 'fixed_round_robin', fixedAlex: true, who: () => alex, at: [38, 40] },
      { method: 'fixed_round_robin', fixedAlex: true, who: () => bea, at: [42, 44] },
    ] as const;
    const seen: Array<{ method: string; booked: unknown; held: unknown }> = [];
    for (const c of cases) {
      const ev = await teamEvent(c.method, c.fixedAlex);
      const [bookedAt, heldAt] = [ev.slots[c.at[0]]!, ev.slots[c.at[1]]!];
      await busy(c.who(), bookedAt);
      expect(await hold(c.who(), heldAt)).toBe('ok');
      const booked = await outcome(await ev.book(bookedAt, `booked-${c.method}-${c.at[0]}@example.org`));
      const held = await outcome(await ev.book(heldAt, `held-${c.method}-${c.at[1]}@example.org`));
      expect(held, `${c.method}, ${c.who() === alex ? 'Alex' : 'Bea'} held`).toEqual(booked);
      seen.push({ method: c.method, booked, held });
    }
    // What the core does with a busy (so a held) host, method by method:
    expect(seen.map((x) => x.held)).toEqual([['bea'], 'SLOT_TAKEN', 'SLOT_TAKEN', ['alex']]);
  });

  it('a hold that commits while hosts are being picked is still respected: the locked insert refuses, nothing is booked', async () => {
    await clearHolds();
    const rr = await teamEvent('round_robin');
    const at = rr.slots[48]!;
    // Alex passes the hold check, then the hold lands during Alex's calendar read.
    const out = await rr.book(at, 'race@example.org', racing(alex, at));
    expect(out).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    const n = await db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM booking WHERE account_id = ${accountId} AND start_ms = ${at}`);
    expect(Number(n!.n)).toBe(0);
  });

  it('a personal booking that asks for holds to count refuses one that lands before its write; the REST default still books', async () => {
    await clearHolds();
    const free = await alexFree();
    const [a, b] = [free[2]!, free[6]!];
    expect(await bookOwn(a, 'mcp-race@example.org', { refuseHeld: true }, racing(alex, a))).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    // Without the option (every REST route), holds are not looked at, exactly as before.
    expect((await bookOwn(b, 'rest-race@example.org', {}, racing(alex, b))).ok).toBe(true);
  });

  it('the hold a personal booking consumes is its own: refuseHeld never refuses it', async () => {
    await clearHolds();
    const at = (await alexFree())[10]!;
    const uid = randomUUID();
    expect(
      await insertHoldGuarded(db, { accountId, eventTypeId: alexOwn, memberId: alex, startMs: at, endMs: at + HALF_HOUR, uid, releaseAtMs: Date.now() + 600_000, now: Date.now() }),
    ).toBe('ok');
    const out = await bookOwn(at, 'own-hold@example.org', { refuseHeld: true, reservationUid: uid });
    expect(out.ok).toBe(true);
  });

  it('a move that asks for holds to count refuses one that lands before its write; the /v2 default still moves', async () => {
    await clearHolds();
    const free = await alexFree();
    const [from1, to1, from2, to2] = [free[14]!, free[16]!, free[18]!, free[20]!];
    const first = await bookOwn(from1, 'move-one@example.org');
    const second = await bookOwn(from2, 'move-two@example.org');
    if (!first.ok || !second.ok) throw new Error('setup booking failed');
    const refused = await rescheduleBookingV2(db, { accountId, uid: first.booking.uid, newStartMs: to1, refuseHeld: true }, racing(alex, to1));
    expect(refused).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    const moved = await rescheduleBookingV2(db, { accountId, uid: second.booking.uid, newStartMs: to2 }, racing(alex, to2));
    expect(moved).toMatchObject({ ok: true });
  });
});
