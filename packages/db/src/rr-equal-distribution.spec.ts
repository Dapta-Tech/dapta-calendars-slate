import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createTeamBooking, getTeamAvailability } from './parity';
import { createEventType, createTeam, getEventTypeById, updateEventType } from './crud';

/**
 * Round robin's distribution method (`event_type.rr_distribution`), the
 * choice Calendly calls "Optimize for availability" vs "Optimize for equal
 * distribution".
 *   - NULL / 'availability' (today): the highest priority free host, then the
 *     lowest load across all of the host's bookings.
 *   - 'equal': only this event's bookings count, a host 3 or more ahead of the
 *     least-booked host offers no times until the others catch up, and
 *     priority is ignored. A host with no schedule yet does not set the floor.
 * Run on the SQLite dev default and, when DATABASE_URL names one, on Postgres.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');

const HOUR = 3_600_000;
const PAST_BASE = Date.now() - 400 * 24 * HOUR;
let loadSeq = Math.floor(Math.random() * 100_000);
const attendee = (tag: string) => ({ name: 'Sam', email: `sam-${tag}@example.com`, timeZone: 'America/New_York' });

function cases(engine: string, open: () => Promise<{ db: Db; fresh: boolean }>) {
  describe(`round robin distribution (${engine})`, () => {
    let db: Db;
    let accountId: string;
    let alexId: string;
    let jordanId: string;

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
      if (isPg && engine === 'Postgres' && db) await db.close();
    });

    let tag: string;
    let made = 0;
    beforeEach(() => {
      tag = randomUUID().slice(0, 8);
    });

    /** A round robin team event hosted by `hosts`, in the given distribution. */
    async function makeEvent(
      rrDistribution: 'availability' | 'equal' | null,
      hosts: Array<{ memberId: string; priority?: number }>,
    ) {
      const key = `rr-${tag}-${++made}`;
      const team = await createTeam(db, accountId, { name: key, slug: key });
      if (!team.ok) throw new Error('team create failed');
      const ev = await createEventType(db, accountId, null, {
        slug: key,
        title: 'Sales intro',
        lengthMinutes: 30,
        schedulingType: 'round_robin',
        rrDistribution,
        scheduleId: null,
        teamId: team.value.id,
      });
      if (!ev.ok) throw new Error('event create failed');
      for (const h of hosts) {
        await db.run(
          sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
              VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${h.memberId}, 0, ${h.priority ?? null}, 100, ${null}, ${Date.now()})`,
        );
      }
      return { teamId: team.value.id, eventTypeId: ev.value.id, teamSlug: key, slug: key };
    }

    /** `n` past accepted bookings for `memberId` on `eventTypeId` (load, no busy time ahead). */
    async function giveBookings(eventTypeId: string | null, teamId: string | null, memberId: string, n: number) {
      for (let i = 0; i < n; i++) {
        // Spaced an hour apart, far in the past: Postgres refuses overlapping
        // bookings for one host, and its database outlives a single run.
        const start = PAST_BASE - ++loadSeq * HOUR;
        await db.run(
          sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title, start_ms, end_ms, status, created_at, updated_at)
              VALUES (${randomUUID()}, ${accountId}, ${randomUUID()}, ${eventTypeId}, ${memberId}, ${teamId}, ${'load'},
                ${start}, ${start + HOUR / 2}, 'accepted', ${start}, ${start})`,
        );
      }
    }

    /** A booking that makes `memberId` busy at `startMs` (any event). */
    async function makeBusy(memberId: string, startMs: number) {
      const already = await db.get<{ id: string }>(
        sql`SELECT id FROM booking WHERE host_member_id = ${memberId} AND start_ms = ${startMs} AND status = 'accepted'`,
      );
      if (already) return; // an earlier case on the shared Postgres made the same time busy
      await db.run(
        sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title, start_ms, end_ms, status, created_at, updated_at)
            VALUES (${randomUUID()}, ${accountId}, ${randomUUID()}, ${null}, ${memberId}, ${null}, ${'busy'},
              ${startMs}, ${startMs + HOUR / 2}, 'accepted', ${Date.now()}, ${Date.now()})`,
      );
    }

    async function slotsOf(ev: { teamSlug: string; slug: string }) {
      const r = await getTeamAvailability(db, {
        accountCode: 'acme',
        teamSlug: ev.teamSlug,
        slug: ev.slug,
        fromMs: Date.now(),
        toMs: Date.now() + 14 * 24 * HOUR,
      });
      return r?.slots ?? [];
    }

    /** An offered time at which none of `memberIds` holds a booking (Postgres keeps earlier runs' rows). */
    async function freeFor(ev: { teamSlug: string; slug: string }, memberIds: string[]) {
      for (const iso of await slotsOf(ev)) {
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
      throw new Error('no time free for both hosts');
    }

    async function book(ev: { teamSlug: string; slug: string }, startIso: string) {
      return createTeamBooking(db, {
        accountCode: 'acme',
        teamSlug: ev.teamSlug,
        slug: ev.slug,
        startMs: Date.parse(startIso),
        attendee: attendee(tag),
      });
    }

    it('stores the choice, and NULL (every existing event) reads as today', async () => {
      const ev = await makeEvent('equal', [{ memberId: alexId }]);
      expect((await getEventTypeById(db, accountId, ev.eventTypeId))?.rrDistribution).toBe('equal');
      await updateEventType(db, accountId, ev.eventTypeId, { rrDistribution: null });
      expect((await getEventTypeById(db, accountId, ev.eventTypeId))?.rrDistribution).toBeNull();
    });

    it('equal: a host 3 bookings ahead offers no times; at 2 ahead they still do', async () => {
      const ev = await makeEvent('equal', [{ memberId: alexId }, { memberId: jordanId }]);
      const first = await freeFor(ev, [alexId]);
      await makeBusy(jordanId, Date.parse(first)); // only Alex is free at `first`

      await giveBookings(ev.eventTypeId, ev.teamId, alexId, 2);
      expect(await slotsOf(ev)).toContain(first);

      await giveBookings(ev.eventTypeId, ev.teamId, alexId, 1); // now 3 ahead of Jordan
      expect(await slotsOf(ev)).not.toContain(first);
      const refused = await book(ev, first);
      expect(refused.ok).toBe(false);
      // Jordan's hours cover the time but a booking fills it, and Alex is held
      // back: the write answers as for any time taken in the meantime.
      expect(!refused.ok && refused.reason).toBe('SLOT_TAKEN');
    });

    it('equal: bookings attended as a co-host (from when the event was collective) count as load', async () => {
      const ev = await makeEvent('equal', [{ memberId: alexId }, { memberId: jordanId }]);
      const first = await freeFor(ev, [alexId]);
      await makeBusy(jordanId, Date.parse(first)); // only Alex is free at `first`
      // Three past bookings Jordan organized with Alex as a co-host.
      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        const start = PAST_BASE - ++loadSeq * HOUR;
        await db.run(
          sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title, start_ms, end_ms, status, created_at, updated_at)
              VALUES (${id}, ${accountId}, ${randomUUID()}, ${ev.eventTypeId}, ${jordanId}, ${ev.teamId}, ${'load'},
                ${start}, ${start + HOUR / 2}, 'accepted', ${start}, ${start})`,
        );
        await db.run(
          sql`INSERT INTO booking_host (id, booking_id, member_id, created_at)
              VALUES (${randomUUID()}, ${id}, ${alexId}, ${start})`,
        );
      }
      // Both now carry three: nobody is ahead, so Alex is still offered.
      expect(await slotsOf(ev)).toContain(first);
      await giveBookings(ev.eventTypeId, ev.teamId, alexId, 3); // Alex 6, Jordan 3: three ahead
      expect(await slotsOf(ev)).not.toContain(first);
    });

    it('availability (NULL): the same host 3 ahead keeps offering, as today', async () => {
      const ev = await makeEvent(null, [{ memberId: alexId }, { memberId: jordanId }]);
      const first = await freeFor(ev, [alexId]);
      await makeBusy(jordanId, Date.parse(first));
      await giveBookings(ev.eventTypeId, ev.teamId, alexId, 5);
      expect(await slotsOf(ev)).toContain(first);
    });

    it('equal ignores priority and counts only this event; availability keeps priority first', async () => {
      // Alex has the higher priority and one booking of this event; Jordan has
      // none of this event but many of another.
      const equal = await makeEvent('equal', [{ memberId: alexId, priority: 2 }, { memberId: jordanId }]);
      await giveBookings(equal.eventTypeId, equal.teamId, alexId, 1);
      await giveBookings(null, null, jordanId, 6);
      const slot = await freeFor(equal, [alexId, jordanId]);
      const picked = await book(equal, slot);
      expect(picked.ok && picked.hostMemberId).toBe(jordanId);

      const byPriority = await makeEvent(null, [{ memberId: alexId, priority: 2 }, { memberId: jordanId }]);
      const slot2 = await freeFor(byPriority, [alexId, jordanId]);
      const picked2 = await book(byPriority, slot2);
      expect(picked2.ok && picked2.hostMemberId).toBe(alexId);
    });

    /** A member who was invited and never signed in: no schedule, so no hours. */
    async function invitedMember() {
      const id = randomUUID();
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
            VALUES (${id}, ${accountId}, ${`inv-${tag}-${++made}`}, ${'Casey Morgan'}, ${`casey-${tag}-${made}@example.com`},
              ${'UTC'}, ${null}, ${Date.now()})`,
      );
      return id;
    }

    it('equal: a host with no schedule yet (an invited member) neither holds the team back nor takes the booking', async () => {
      const invitedId = await invitedMember();
      const ev = await makeEvent('equal', [{ memberId: alexId }, { memberId: jordanId }, { memberId: invitedId }]);
      await giveBookings(ev.eventTypeId, ev.teamId, alexId, 4);
      await giveBookings(ev.eventTypeId, ev.teamId, jordanId, 4);
      expect((await slotsOf(ev)).length).toBeGreaterThan(0);
      // Zero bookings would make them the fairest pick, but they have no hours.
      const booked = await book(ev, await freeFor(ev, [alexId, jordanId]));
      expect(booked.ok && booked.hostMemberId).not.toBe(invitedId);
      expect(booked.ok).toBe(true);
    });

    it('availability (NULL): a host with no schedule is never assigned, however light their load', async () => {
      const invitedId = await invitedMember();
      const ev = await makeEvent(null, [{ memberId: alexId }, { memberId: jordanId }, { memberId: invitedId }]);
      await giveBookings(null, null, alexId, 2);
      await giveBookings(null, null, jordanId, 2);
      const booked = await book(ev, await freeFor(ev, [alexId, jordanId]));
      expect(booked.ok).toBe(true);
      expect(booked.ok && [alexId, jordanId]).toContain(booked.ok ? booked.hostMemberId : '');
    });

    /** A member with working hours like the seeded hosts (weekdays 09:00 to 17:00, New York) and no bookings. */
    async function workingHost(name: string) {
      const id = randomUUID();
      const scheduleId = randomUUID();
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
            VALUES (${id}, ${accountId}, ${`wh-${tag}-${++made}`}, ${name}, ${`wh-${tag}-${made}@example.com`},
              ${'America/New_York'}, ${scheduleId}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
            VALUES (${scheduleId}, ${accountId}, ${id}, ${'Working hours'}, ${'America/New_York'}, ${Date.now()})`,
      );
      await db.run(
        sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
            VALUES (${randomUUID()}, ${scheduleId}, ${'[1,2,3,4,5]'}, ${'09:00'}, ${'17:00'}, ${null})`,
      );
      return id;
    }

    /**
     * Runs the requests so that every one has read the loads before any of
     * them writes. On Postgres the test holds the event's advisory lock (the
     * key `insertEqualShareGuarded` takes) until all of them wait on it, past
     * their reads; SQLite interleaves them in this one process already.
     */
    async function allAtOnce<T>(eventTypeId: string, requests: Array<() => Promise<T>>): Promise<T[]> {
      if (db.dialect === 'sqlite') return Promise.all(requests.map((r) => r()));
      let results!: Promise<T[]>;
      await db.pg!.drizzle.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`slate:rr-equal:${eventTypeId}`}, 0))`);
        results = Promise.all(requests.map((r) => r()));
        const deadline = Date.now() + 10_000;
        for (;;) {
          const waiting = await db.get<{ n: number | string }>(
            sql`SELECT COUNT(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (Number(waiting?.n ?? 0) >= requests.length) break;
          if (Date.now() > deadline) throw new Error('the requests never reached the event lock');
          await new Promise((r) => setTimeout(r, 20));
        }
      });
      return results;
    }

    it('equal: bookings made at once never all read the same lightest host; the pick runs one at a time per event', async () => {
      // Two hosts of this run only, so every offered time is free for both,
      // however many runs a shared Postgres database has kept.
      const caseyId = await workingHost('Casey Morgan');
      const rileyId = await workingHost('Riley Chen');
      const ev = await makeEvent('equal', [{ memberId: caseyId }, { memberId: rileyId }]);
      // Six times booked all at once: each request reads the loads before any
      // of them writes, so without the per-event lock every one of them would
      // pick the same host.
      const times = (await slotsOf(ev)).slice(0, 6);
      expect(times).toHaveLength(6);
      const outs = await allAtOnce(
        ev.eventTypeId,
        times.map((iso, i) => () =>
          createTeamBooking(db, {
            accountCode: 'acme',
            teamSlug: ev.teamSlug,
            slug: ev.slug,
            startMs: Date.parse(iso),
            attendee: attendee(`${tag}-at-once-${i}`),
          }),
        ),
      );
      const hosts = outs.map((o) => (o.ok ? o.hostMemberId : `refused:${!o.ok && o.reason}`));
      expect(hosts.filter((h) => h === caseyId)).toHaveLength(3);
      expect(hosts.filter((h) => h === rileyId)).toHaveLength(3);
      // What the event's own rows say, not only what the calls answered.
      const rows = await db.all<{ host_member_id: string }>(
        sql`SELECT host_member_id FROM booking WHERE event_type_id = ${ev.eventTypeId} AND status = 'accepted'`,
      );
      expect(rows.filter((r) => r.host_member_id === caseyId)).toHaveLength(3);
      expect(rows.filter((r) => r.host_member_id === rileyId)).toHaveLength(3);
    }, 20_000);

    it('equal: a host held back when the requests arrive is picked again once the others catch up under the lock', async () => {
      // Casey starts 3 bookings ahead, so every one of six requests made at
      // once reads Casey as held back. Under the lock the first ones go to
      // Riley; once Riley catches up Casey is no longer held back, and the
      // rest share out. A pick that only knew the hosts free AND not held back
      // when each request arrived would give Riley all six (Riley 3 ahead).
      const caseyId = await workingHost('Casey Morgan');
      const rileyId = await workingHost('Riley Chen');
      const ev = await makeEvent('equal', [{ memberId: caseyId }, { memberId: rileyId }]);
      await giveBookings(ev.eventTypeId, ev.teamId, caseyId, 3);
      const times = (await slotsOf(ev)).slice(0, 6);
      expect(times).toHaveLength(6);
      const outs = await allAtOnce(
        ev.eventTypeId,
        times.map((iso, i) => () =>
          createTeamBooking(db, {
            accountCode: 'acme',
            teamSlug: ev.teamSlug,
            slug: ev.slug,
            startMs: Date.parse(iso),
            attendee: attendee(`${tag}-caught-up-${i}`),
          }),
        ),
      );
      expect(outs.map((o) => o.ok)).toEqual([true, true, true, true, true, true]);
      const rows = await db.all<{ host_member_id: string }>(
        sql`SELECT host_member_id FROM booking WHERE event_type_id = ${ev.eventTypeId} AND status = 'accepted'`,
      );
      const casey = rows.filter((r) => r.host_member_id === caseyId).length;
      const riley = rows.filter((r) => r.host_member_id === rileyId).length;
      expect(casey + riley).toBe(9);
      // Riley takes the first three (to 3 and 3), then the six end within one of each other.
      expect(Math.abs(casey - riley)).toBeLessThanOrEqual(1);
    }, 20_000);
  });
}

cases('SQLite', async () => ({ db: await createDb('file::memory:'), fresh: true }));
if (isPg) cases('Postgres', async () => ({ db: await createDb(url), fresh: false }));
