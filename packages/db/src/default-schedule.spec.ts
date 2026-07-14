import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createSchedule, deleteSchedule } from './crud';

/**
 * QA fix 2 — the phantom default schedule. Creating a member's FIRST schedule
 * must also make it their default: the availability classifier falls back to
 * `member.default_schedule_id`, and before this fix nothing in the app ever
 * wrote that column (only the demo seed did), so every real user hit
 * NO_SCHEDULE ("You don't have a schedule yet") even after configuring hours.
 */
describe('default schedule assignment (QA fix 2)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    accountId = 'acct-1';
    memberId = 'mem-1';
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at) VALUES (${accountId}, ${'test01'}, ${'Test'}, ${Date.now()})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
          VALUES (${memberId}, ${accountId}, ${'tester'}, ${'Tester'}, ${'t@example.com'}, ${'UTC'}, ${Date.now()})`,
    );
  });

  async function memberDefault(): Promise<string | null> {
    const row = await db.get<{ default_schedule_id: string | null }>(
      sql`SELECT default_schedule_id FROM member WHERE id = ${memberId}`,
    );
    return row?.default_schedule_id ?? null;
  }

  it('first schedule becomes the member default', async () => {
    expect(await memberDefault()).toBeNull();
    const s = await createSchedule(db, accountId, memberId, {
      name: 'Working hours',
      timeZone: 'America/Mexico_City',
      rules: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null }],
    });
    expect(await memberDefault()).toBe(s.id);
  });

  it('a second schedule does NOT steal the default', async () => {
    const first = await createSchedule(db, accountId, memberId, { name: 'A', timeZone: 'UTC' });
    await createSchedule(db, accountId, memberId, { name: 'B', timeZone: 'UTC' });
    expect(await memberDefault()).toBe(first.id);
  });

  it('deleting the default re-points to the oldest remaining schedule (existing behavior)', async () => {
    const first = await createSchedule(db, accountId, memberId, { name: 'A', timeZone: 'UTC' });
    const second = await createSchedule(db, accountId, memberId, { name: 'B', timeZone: 'UTC' });
    await deleteSchedule(db, accountId, first.id);
    expect(await memberDefault()).toBe(second.id);
  });
});
