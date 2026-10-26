import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createTeamBooking, getTeamAvailability } from './parity';
import { createEventType, createTeam } from './crud';
import { memberWithHours, WEEKDAYS } from './member-hours.fixture';

/**
 * A team booking goes only to a host whose OWN hours offer the time.
 *
 * The pick used to weigh bookings, holds and calendars, never the host's
 * rules. So on a round robin event a host outside their hours, or an invited
 * member with no schedule yet (no bookings, so the lightest load), won the
 * booking for a time another host's hours offered; on fixed round robin, the
 * rotating pick did. Collective already required every host's hours.
 * Run on the SQLite dev default and, when DATABASE_URL names one, on Postgres.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const HOUR = 3_600_000;
const PAST_BASE = Date.now() - 400 * 24 * HOUR;
let loadSeq = Math.floor(Math.random() * 100_000);

function cases(engine: string, open: () => Promise<{ db: Db; fresh: boolean }>) {
  describe(`team bookings respect each host's own hours (${engine})`, () => {
    let db: Db;
    let accountId: string;
    let alexId: string;
    let jordanId: string;
    const tag = randomUUID().slice(0, 8);
    let made = 0;

    beforeAll(async () => {
      const opened = await open();
      db = opened.db;
      await migrate(db);
      const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
      if (opened.fresh || !existing) await seed(db);
      accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
      alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
      jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    });

    afterAll(async () => {
      if (engine === 'Postgres' && db) await db.close();
    });

    async function makeEvent(
      schedulingType: 'round_robin' | 'fixed_round_robin',
      hosts: Array<{ memberId: string; isFixed?: boolean }>,
    ) {
      const key = `hh-${tag}-${++made}`;
      const team = await createTeam(db, accountId, { name: key, slug: key });
      if (!team.ok) throw new Error('team create failed');
      const ev = await createEventType(db, accountId, null, {
        slug: key,
        title: 'Sales intro',
        lengthMinutes: 30,
        schedulingType,
        scheduleId: null,
        teamId: team.value.id,
      });
      if (!ev.ok) throw new Error('event create failed');
      for (const h of hosts) {
        await db.run(
          sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
              VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${h.memberId}, ${h.isFixed ? 1 : 0}, ${null}, 100, ${null}, ${Date.now()})`,
        );
      }
      return { teamSlug: key, slug: key };
    }

    /** A member invited and never signed in: no schedule, so no hours. */
    async function invitedMember() {
      const id = randomUUID();
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, status, created_at)
            VALUES (${id}, ${accountId}, ${`inv-${tag}-${++made}`}, ${'Casey Morgan'}, ${`casey-${tag}-${made}@example.com`},
              ${'UTC'}, ${null}, ${'invited'}, ${Date.now()})`,
      );
      return id;
    }

    /** A member whose only hours are 03:00 to 04:00 UTC on weekdays, never in Alex's day. */
    async function nightOwl() {
      const n = ++made;
      const owl = await memberWithHours(db, {
        accountId,
        handle: `owl-${tag}-${n}`,
        name: 'Taylor Brooks',
        email: `taylor-${tag}-${n}@example.com`,
        timeZone: 'UTC',
        scheduleName: 'Nights',
        days: WEEKDAYS,
        startTime: '03:00',
        endTime: '04:00',
      });
      return owl.id;
    }

    /** A member in Alex's zone whose weekday hours start at 9:15, off Alex's half-hour grid. */
    async function quarterPast() {
      const n = ++made;
      const host = await memberWithHours(db, {
        accountId,
        handle: `qp-${tag}-${n}`,
        name: 'Riley Chen',
        email: `riley-${tag}-${n}@example.com`,
        timeZone: 'America/New_York',
        scheduleName: 'Quarter past',
        days: WEEKDAYS,
        startTime: '09:15',
        endTime: '17:00',
      });
      return host.id;
    }

    /** Past accepted bookings, so `memberId` carries load without busy time ahead. */
    async function giveLoad(memberId: string, n: number) {
      for (let i = 0; i < n; i++) {
        // An hour apart, far in the past: Postgres refuses overlapping bookings
        // for one host, and its database outlives a single run.
        const start = PAST_BASE - ++loadSeq * HOUR;
        await db.run(
          sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title, start_ms, end_ms, status, created_at, updated_at)
              VALUES (${randomUUID()}, ${accountId}, ${randomUUID()}, ${null}, ${memberId}, ${null}, ${'load'},
                ${start}, ${start + HOUR / 2}, 'accepted', ${start}, ${start})`,
        );
      }
    }

    /** An offered time at which none of `memberIds` holds a booking (Postgres keeps earlier runs' rows). */
    async function freeFor(
      ev: { teamSlug: string; slug: string },
      memberIds: string[],
      keep: (iso: string) => boolean = () => true,
    ) {
      const r = await getTeamAvailability(db, {
        accountCode: 'acme',
        teamSlug: ev.teamSlug,
        slug: ev.slug,
        fromMs: Date.now(),
        toMs: Date.now() + 14 * 24 * HOUR,
      });
      for (const iso of (r?.slots ?? []).filter(keep)) {
        const start = Date.parse(iso);
        let clear = true;
        for (const m of memberIds) {
          const hit = await db.get<{ id: string }>(
            sql`SELECT id FROM booking WHERE host_member_id = ${m} AND status = 'accepted'
                AND start_ms < ${start + HOUR / 2} AND end_ms > ${start} LIMIT 1`,
          );
          if (hit) clear = false;
        }
        if (clear) return iso;
      }
      throw new Error('no time free for the hosts');
    }

    /** New York wall-clock "HH:MM" of an instant. */
    const nyClock = (iso: string) =>
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
        new Date(iso),
      );
    /** A time inside Alex's seeded day (New York, from 10:00), never another host's own block. */
    const inAlexDay = (iso: string) => nyClock(iso) >= '10:00' && nyClock(iso) <= '15:30';

    async function book(ev: { teamSlug: string; slug: string }, startIso: string) {
      const out = await createTeamBooking(db, {
        accountCode: 'acme',
        teamSlug: ev.teamSlug,
        slug: ev.slug,
        startMs: Date.parse(startIso),
        attendee: { name: 'Sam', email: `sam-${tag}-${++made}@example.com`, timeZone: 'America/New_York' },
      });
      if (!out.ok) throw new Error(`booking refused: ${out.reason}`);
      return out.hostMemberId;
    }

    it('round robin: an invited member with no schedule never takes the booking, however light their load', async () => {
      const invitedId = await invitedMember();
      const ev = await makeEvent('round_robin', [{ memberId: alexId }, { memberId: invitedId }]);
      await giveLoad(alexId, 2);
      expect(await book(ev, await freeFor(ev, [alexId], inAlexDay))).toBe(alexId);
    });

    it('round robin: a host outside their own hours never takes the booking', async () => {
      const owlId = await nightOwl();
      const ev = await makeEvent('round_robin', [{ memberId: alexId }, { memberId: owlId }]);
      await giveLoad(alexId, 2);
      expect(await book(ev, await freeFor(ev, [alexId], inAlexDay))).toBe(alexId);
    });

    it('round robin: a host whose hours do cover the time still takes it on a lighter load', async () => {
      const ev = await makeEvent('round_robin', [{ memberId: alexId }, { memberId: jordanId }]);
      await giveLoad(alexId, 50);
      expect(await book(ev, await freeFor(ev, [alexId, jordanId], inAlexDay))).toBe(jordanId);
    });

    it("round robin: a host whose hours cover the time off their own grid still takes it", async () => {
      // Alex's grid is :00 and :30 from 9:00; Riley's starts at 9:15. A 10:30
      // New York time is only on Alex's grid, yet inside Riley's hours.
      const rileyId = await quarterPast();
      const ev = await makeEvent('round_robin', [{ memberId: alexId }, { memberId: rileyId }]);
      await giveLoad(alexId, 50);
      const at1030 = (iso: string) => nyClock(iso) === '10:30';
      expect(await book(ev, await freeFor(ev, [alexId, rileyId], at1030))).toBe(rileyId);
    });

    it('fixed round robin: the rotating pick skips a member with no schedule', async () => {
      const invitedId = await invitedMember();
      const ev = await makeEvent('fixed_round_robin', [
        { memberId: alexId, isFixed: true },
        { memberId: jordanId },
        { memberId: invitedId },
      ]);
      await giveLoad(jordanId, 50);
      const slot = await freeFor(ev, [alexId, jordanId], inAlexDay);
      await book(ev, slot);
      const assigned = await db.all<{ member_id: string }>(
        sql`SELECT bh.member_id FROM booking_host bh JOIN booking b ON b.id = bh.booking_id
            WHERE b.start_ms = ${Date.parse(slot)} AND b.title = 'Sales intro' AND b.status = 'accepted'`,
      );
      const ids = assigned.map((r) => r.member_id);
      expect(ids).toContain(jordanId);
      expect(ids).not.toContain(invitedId);
    });
  });
}

cases('SQLite', async () => ({ db: await createDb('file::memory:'), fresh: true }));
if (isPg) cases('Postgres', async () => ({ db: await createDb(url), fresh: false }));
