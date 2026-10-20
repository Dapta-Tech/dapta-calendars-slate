import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { addTeamMember, createTeam, listTeamMembers } from './crud';
import { createConnection } from './parity';

/**
 * `has_destination_calendar` against a REAL Postgres. Its SQLite twin
 * (`team-members-calendar.spec.ts`) owns the rules; this file exists for the
 * one place the dialects could diverge: the CASE over EXISTS must come back as
 * a value that reads as 0/1 on Postgres too, or every host would read as having
 * no calendar (or all of them as having one) in production only.
 *
 * Every fixture here is created by this file and unique per run: a Postgres
 * `DATABASE_URL` is a persistent, SHARED database that other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('listTeamMembers: has_destination_calendar (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let teamId: string;
  const withCalendar = randomUUID();
  const withoutCalendar = randomUUID();

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    accountId = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${'tm' + accountId.slice(0, 6)}, ${'Team Calendar Co'}, ${Date.now()})`,
    );
    for (const [id, name] of [
      [withCalendar, 'Has Calendar'],
      [withoutCalendar, 'No Calendar'],
    ] as const) {
      await db.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
            VALUES (${id}, ${accountId}, ${'h' + id.slice(0, 8)}, ${name}, ${`${id.slice(0, 8)}@example.test`},
              ${'UTC'}, ${Date.now()})`,
      );
    }
    const team = await createTeam(db, accountId, { name: 'Pg Team', slug: 'pg-team' });
    if (!team.ok) throw new Error('setup: team');
    teamId = team.value.id;
    await addTeamMember(db, accountId, teamId, withCalendar);
    await addTeamMember(db, accountId, teamId, withoutCalendar);
    await createConnection(db, {
      accountId,
      memberId: withCalendar,
      provider: 'generic',
      externalId: `pg-dest-${withCalendar}`,
      isDestination: true,
    });
    // A conflict-only calendar is not where bookings are written.
    await createConnection(db, {
      accountId,
      memberId: withoutCalendar,
      provider: 'generic',
      externalId: `pg-read-${withoutCalendar}`,
      isDestination: false,
    });
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('names the member with a destination calendar, and only that one', async () => {
    const rows = await listTeamMembers(db, accountId, teamId);
    const flags = Object.fromEntries(rows.map((r) => [r.member_id, r.has_destination_calendar]));
    expect(flags).toEqual({ [withCalendar]: true, [withoutCalendar]: false });
    // Additive: the fields the response always had are still there.
    expect(rows.find((r) => r.member_id === withCalendar)).toMatchObject({
      role: 'member',
      display_name: 'Has Calendar',
    });
  });

  it('is scoped to the account: another account reads no roster at all', async () => {
    expect(await listTeamMembers(db, randomUUID(), teamId)).toEqual([]);
  });
});
