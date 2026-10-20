import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import {
  addTeamMember,
  createEventType,
  createTeam,
  getEventTypeById,
  removeTeamMember,
  setEventTypeHostsDetailed,
} from './crud';

/**
 * A team's roster and its events' hosts move together. The event editor lists
 * every team member as a host, but adding a member used to leave the team's
 * events without them until someone saved each event again, and removing one
 * left their host row behind, so bookings kept reaching someone no longer on
 * the team (booking reads the host rows, not the roster).
 *
 * Runs on SQLite, and on Postgres too when DATABASE_URL names one. Every test
 * makes its own account, so nothing here touches the seeded demo or another
 * file's rows on a shared Postgres.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const engines: Array<[string, string]> = [
  ['SQLite', 'file::memory:'],
  ...(isPg ? [['Postgres', url] as [string, string]] : []),
];

interface HostRow {
  member_id: string;
  account_id: string;
  is_fixed: number;
  priority: number | null;
  weight: number | null;
  schedule_id: string | null;
}

describe.each(engines)('team roster and event hosts (%s)', (_engine, dbUrl) => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb(dbUrl);
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const hostsOf = (eventTypeId: string) =>
    db.all<HostRow>(
      sql`SELECT member_id, account_id, is_fixed, priority, weight, schedule_id FROM event_type_host
          WHERE event_type_id = ${eventTypeId}`,
    );
  const hostIds = async (eventTypeId: string) =>
    (await hostsOf(eventTypeId)).map((h) => h.member_id).sort();

  /**
   * A fresh account: an owner who owns the team "Sales" and hosts its two
   * events (round-robin and collective, the owner with their own priority and
   * weight), Ana (signed in, so she has a schedule), Ben (invited, no schedule
   * yet), a second team "Support" with one event, and the owner's personal
   * event.
   */
  async function workspace() {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    const member = async (name: string, opts: { invited?: boolean } = {}) => {
      const id = randomUUID();
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
            VALUES (${id}, ${accountId}, ${`${name}-${tag}`}, ${name}, ${`${name}-${tag}@example.com`}, 'UTC', 0)`,
      );
      if (!opts.invited) await giveSchedule(accountId, id);
      return id;
    };
    const owner = await member('owner');
    const ana = await member('ana');
    const ben = await member('ben', { invited: true });

    const team = async (name: string) => {
      const created = await createTeam(db, accountId, {
        name,
        slug: `${name.toLowerCase()}-${tag}`,
      });
      if (!created.ok) throw new Error('setup: team');
      await addTeamMember(db, accountId, created.value.id, owner, 'owner');
      return created.value.id;
    };
    const event = async (teamId: string | null, slug: string, schedulingType: string | null) => {
      const created = await createEventType(db, accountId, teamId ? null : owner, {
        slug,
        title: slug,
        lengthMinutes: 30,
        teamId,
        schedulingType,
        hosts: teamId ? [{ memberId: owner, priority: 2, weight: 50, isFixed: false }] : undefined,
      });
      if (!created.ok) throw new Error(`setup: ${slug}`);
      return created.value.id;
    };

    const sales = await team('Sales');
    const support = await team('Support');
    return {
      accountId,
      member,
      owner,
      ana,
      ben,
      sales,
      support,
      salesRoundRobin: await event(sales, 'demo', 'round_robin'),
      salesCollective: await event(sales, 'all-hands', 'collective'),
      supportEvent: await event(support, 'help', 'round_robin'),
      personal: await event(null, 'intro', null),
    };
  }

  /** What a first sign-in does for an invited member: a default schedule. */
  async function giveSchedule(accountId: string, memberId: string) {
    const scheduleId = randomUUID();
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, 'Working Hours', 'UTC', 0)`,
    );
    await db.run(sql`UPDATE member SET default_schedule_id = ${scheduleId} WHERE id = ${memberId}`);
  }

  it('adding a member makes them a host of every event the team has, with the editor defaults', async () => {
    const w = await workspace();
    expect((await addTeamMember(db, w.accountId, w.sales, w.ana)).ok).toBe(true);

    for (const eventTypeId of [w.salesRoundRobin, w.salesCollective]) {
      const ana = (await hostsOf(eventTypeId)).find((h) => h.member_id === w.ana);
      expect(ana).toEqual({
        member_id: w.ana,
        account_id: w.accountId,
        is_fixed: 0,
        priority: 0,
        weight: 100,
        schedule_id: null,
      });
      // What the editor reads back.
      const view = await getEventTypeById(db, w.accountId, eventTypeId);
      expect(view?.hosts.map((h) => h.memberId).sort()).toEqual([w.ana, w.owner].sort());
    }
    // Another team's event and a personal event are not this team's.
    expect(await hostIds(w.supportEvent)).toEqual([w.owner]);
    expect(await hostIds(w.personal)).toEqual([]);
  });

  it('an invited member with no schedule yet joins round-robin events but not collective ones', async () => {
    const w = await workspace();
    expect((await addTeamMember(db, w.accountId, w.sales, w.ben)).ok).toBe(true);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.ben, w.owner].sort());
    // Everyone attends a collective event, so a host with no hours would
    // empty it for the whole team.
    expect(await hostIds(w.salesCollective)).toEqual([w.owner]);

    // Once they have a schedule, adding them again completes it.
    await giveSchedule(w.accountId, w.ben);
    await addTeamMember(db, w.accountId, w.sales, w.ben);
    expect(await hostIds(w.salesCollective)).toEqual([w.ben, w.owner].sort());
  });

  it('removal clears a collective host row whoever wrote it, schedule or not', async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ben);
    // An editor save writes every listed member, invited or not.
    await setEventTypeHostsDetailed(db, w.accountId, w.salesCollective, [
      { memberId: w.owner, priority: 0, weight: 100, isFixed: false },
      { memberId: w.ben, priority: 0, weight: 100, isFixed: false },
    ]);

    expect((await removeTeamMember(db, w.accountId, w.sales, w.ben)).ok).toBe(true);
    expect(await hostIds(w.salesCollective)).toEqual([w.owner]);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.owner]);
  });

  it('two adds of one member at once write one row per event, and neither fails', async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await db.run(sql`DELETE FROM event_type_host WHERE member_id = ${w.ana}`);

    // Both read "missing" before either writes.
    const results = await Promise.all([
      addTeamMember(db, w.accountId, w.sales, w.ana),
      addTeamMember(db, w.accountId, w.sales, w.ana),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.ana, w.owner].sort());
    expect(await hostIds(w.salesCollective)).toEqual([w.ana, w.owner].sort());
  });

  it("an editor save that meets a team add's row mid-save keeps every host, with the editor's values", async () => {
    const w = await workspace();
    // Hosts the save writes before and after Ana, so the add lands in between.
    const before = [];
    for (const name of ['p', 'q', 'r', 's', 't', 'u']) before.push(await w.member(name));
    const after = await w.member('v');
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await db.run(sql`DELETE FROM event_type_host WHERE member_id = ${w.ana}`);
    const host = (memberId: string, priority = 0) => ({
      memberId,
      priority,
      weight: 100,
      isFixed: false,
    });

    // The add reads "Ana is missing" after the save's DELETE and writes her
    // row before the save reaches her; the save must not fail on it, and the
    // host after her must still be written.
    await Promise.all([
      setEventTypeHostsDetailed(db, w.accountId, w.salesRoundRobin, [
        ...before.map((id) => host(id)),
        host(w.ana, 7),
        host(after),
      ]),
      addTeamMember(db, w.accountId, w.sales, w.ana),
    ]);
    expect(await hostIds(w.salesRoundRobin)).toEqual([...before, w.ana, after].sort());
    const ana = (await hostsOf(w.salesRoundRobin)).find((h) => h.member_id === w.ana)!;
    expect(ana.priority).toBe(7);
  });

  it('adding twice, or adding someone who already hosts, writes no second row and keeps their settings', async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await addTeamMember(db, w.accountId, w.sales, w.owner, 'owner');

    const rows = await hostsOf(w.salesRoundRobin);
    expect(rows.map((h) => h.member_id).sort()).toEqual([w.ana, w.owner].sort());
    const owner = rows.find((h) => h.member_id === w.owner)!;
    expect([owner.priority, owner.weight]).toEqual([2, 50]);
  });

  it('a repeated add completes a host row the first one did not write', async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await db.run(
      sql`DELETE FROM event_type_host WHERE event_type_id = ${w.salesCollective} AND member_id = ${w.ana}`,
    );

    expect((await addTeamMember(db, w.accountId, w.sales, w.ana)).ok).toBe(true);
    expect(await hostIds(w.salesCollective)).toEqual([w.ana, w.owner].sort());
  });

  it("removing a member clears their host rows on that team's events only", async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    await addTeamMember(db, w.accountId, w.support, w.ana);

    expect((await removeTeamMember(db, w.accountId, w.sales, w.ana)).ok).toBe(true);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.owner]);
    expect(await hostIds(w.salesCollective)).toEqual([w.owner]);
    // Still on Support, so still hosting there.
    expect(await hostIds(w.supportEvent)).toEqual([w.ana, w.owner].sort());
  });

  it('a refused removal (the last owner) leaves the hosts as they were', async () => {
    const w = await workspace();
    const r = await removeTeamMember(db, w.accountId, w.sales, w.owner);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('LAST_OWNER');
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.owner]);
  });

  it('removing someone already off the team still clears a host row they kept', async () => {
    const w = await workspace();
    // What a removal before this change left behind: a host who is not a member.
    await db.run(
      sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
          VALUES (${randomUUID()}, ${w.accountId}, ${w.salesRoundRobin}, ${w.ben}, 0, 0, 100, ${null}, 0)`,
    );
    expect((await removeTeamMember(db, w.accountId, w.sales, w.ben)).ok).toBe(true);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.owner]);
  });

  it("another account can neither add hosts to this team's events nor strip them", async () => {
    const w = await workspace();
    await addTeamMember(db, w.accountId, w.sales, w.ana);
    const stranger = randomUUID();

    expect((await addTeamMember(db, stranger, w.sales, w.ben)).ok).toBe(false);
    await removeTeamMember(db, stranger, w.sales, w.ana);
    expect(await hostIds(w.salesRoundRobin)).toEqual([w.ana, w.owner].sort());
  });
});
