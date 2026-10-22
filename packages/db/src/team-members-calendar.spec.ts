import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { listTeamMembers } from './crud';
import { createConnection } from './parity';

/**
 * `listTeamMembers` says which members have a destination calendar. A team
 * event has one location for every host, and its meeting link is minted on the
 * ASSIGNED host's own destination calendar, so the editor names the hosts who
 * have none. Only a calendar marked as the destination counts, and only one in
 * the team's own account.
 */
describe('listTeamMembers: has_destination_calendar (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let teamId: string;
  let alexId: string;
  let jordanId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    teamId = (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug = 'sales'`))!.id;
    alexId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
    jordanId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'jordan-lee'`,
    ))!.id;
  });

  const flags = async () =>
    Object.fromEntries(
      (await listTeamMembers(db, accountId, teamId)).map((r) => [
        r.member_id,
        r.has_destination_calendar,
      ]),
    );

  it('is false for every member until one connects a destination calendar', async () => {
    expect(await flags()).toEqual({ [alexId]: false, [jordanId]: false });

    await createConnection(db, {
      accountId,
      memberId: alexId,
      provider: 'generic',
      externalId: 'a',
      isDestination: true,
    });
    expect(await flags()).toEqual({ [alexId]: true, [jordanId]: false });
  });

  it('keeps every field the response already had', async () => {
    await createConnection(db, {
      accountId,
      memberId: alexId,
      provider: 'generic',
      externalId: 'a',
      isDestination: true,
    });
    const alex = (await listTeamMembers(db, accountId, teamId)).find((r) => r.member_id === alexId);
    expect(alex).toEqual({
      member_id: alexId,
      role: 'member',
      accepted: 1,
      display_name: 'Alex Rivera',
      email: 'alex@example.com',
      has_destination_calendar: true,
      has_calendar: true,
      has_hours: true,
    });
  });

  it('has_calendar counts any connected calendar, a conflict-only one included', async () => {
    const calendars = async () =>
      Object.fromEntries((await listTeamMembers(db, accountId, teamId)).map((r) => [r.member_id, r.has_calendar]));
    expect(await calendars()).toEqual({ [alexId]: false, [jordanId]: false });
    await createConnection(db, { accountId, memberId: jordanId, provider: 'generic', externalId: 'j', isDestination: false });
    expect(await calendars()).toEqual({ [alexId]: false, [jordanId]: true });
  });

  it('has_hours needs a default schedule with at least one rule: an invited member has none', async () => {
    const invitedId = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, status, created_at)
          VALUES (${invitedId}, ${accountId}, ${'casey-morgan'}, ${'Casey Morgan'}, ${'casey@example.com'}, ${'UTC'},
            ${null}, ${'invited'}, ${Date.now()})`,
    );
    await db.run(
      sql`INSERT INTO team_membership (id, account_id, team_id, member_id, role, accepted, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${teamId}, ${invitedId}, 'member', 1, ${Date.now()})`,
    );
    const hours = async () =>
      Object.fromEntries((await listTeamMembers(db, accountId, teamId)).map((r) => [r.member_id, r.has_hours]));
    // The seeded hosts have working hours; the invitee has no schedule yet.
    expect(await hours()).toEqual({ [alexId]: true, [jordanId]: true, [invitedId]: false });

    // A schedule with every rule deleted offers nothing either.
    const jordanSchedule = (await db.get<{ id: string }>(
      sql`SELECT default_schedule_id AS id FROM member WHERE id = ${jordanId}`,
    ))!.id;
    await db.run(sql`DELETE FROM availability WHERE schedule_id = ${jordanSchedule}`);
    expect((await hours())[jordanId]).toBe(false);
  });

  it('does not count a calendar that is only checked for conflicts', async () => {
    await createConnection(db, {
      accountId,
      memberId: jordanId,
      provider: 'generic',
      externalId: 'j',
      isDestination: false,
    });
    expect((await flags())[jordanId]).toBe(false);
  });

  it('does not count a destination row that belongs to another account', async () => {
    const otherAccount = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at) VALUES (${otherAccount}, 'other', 'Other', ${Date.now()})`,
    );
    await createConnection(db, {
      accountId: otherAccount,
      memberId: jordanId,
      provider: 'generic',
      externalId: 'foreign',
      isDestination: true,
    });
    expect((await flags())[jordanId]).toBe(false);
  });
});
