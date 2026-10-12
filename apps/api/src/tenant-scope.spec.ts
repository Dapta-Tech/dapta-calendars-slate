import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  addTeamMember,
  createDb,
  createEventType,
  createTeam,
  deleteEventType,
  deleteTeam,
  migrate,
  seed,
  sql,
  type Db,
} from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';

/**
 * The host write paths take the principal's account and member from the
 * authenticated session. The controllers hand the service the raw request body
 * (no global ValidationPipe), so these pin that a body naming ANOTHER account's
 * ids cannot redirect a write there.
 */
describe('tenant scope on host writes', () => {
  let db: Db;
  let admin: AdminService;
  let principal: { accountId: string; memberId: string; role: 'owner' };
  let victim: { accountId: string; memberId: string };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    principal = { accountId, memberId, role: 'owner' };

    victim = { accountId: randomUUID(), memberId: randomUUID() };
    const now = Date.now();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${victim.accountId}, ${'other'}, ${'Other Co.'}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, role, created_at)
          VALUES (${victim.memberId}, ${victim.accountId}, ${'victim'}, ${'Victim'}, ${'victim@example.com'}, ${'owner'}, ${now})`,
    );

    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    admin = new AdminService(db, calendar, email);
  });

  it('POST /v1/api-keys: a body accountId cannot mint a key for another account', async () => {
    const body = { name: 'k', scopes: ['bookings:read'], accountId: victim.accountId } as never;
    await admin.createApiKey(principal, body);
    const rows = await db.all<{ account_id: string }>(sql`SELECT account_id FROM api_key`);
    expect(rows.map((r) => r.account_id)).toEqual([principal.accountId]);
  });

  it('POST /v1/connections: body accountId/memberId/avatarUrl cannot redirect the connection', async () => {
    const body = {
      provider: 'google',
      externalId: 'ext-1',
      accountId: victim.accountId,
      memberId: victim.memberId,
      avatarUrl: 'https://attacker.example/x.png',
    } as never;
    await admin.createConnection(principal, body);
    const rows = await db.all<{ account_id: string; member_id: string; avatar_url: string | null }>(
      sql`SELECT account_id, member_id, avatar_url FROM connected_calendar`,
    );
    expect(rows).toEqual([{ account_id: principal.accountId, member_id: principal.memberId, avatar_url: null }]);
  });

  it("DELETE /v1/teams/:id: another account's team keeps its roster", async () => {
    const team = await createTeam(db, victim.accountId, { name: 'Sales', slug: 'sales' });
    if (!team.ok) throw new Error('setup');
    expect((await addTeamMember(db, victim.accountId, team.value.id, victim.memberId)).ok).toBe(true);

    await deleteTeam(db, principal.accountId, team.value.id);

    const members = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM team_membership WHERE team_id = ${team.value.id}`,
    );
    expect(Number(members?.n)).toBe(1);
    expect(await db.get(sql`SELECT id FROM team WHERE id = ${team.value.id}`)).toBeTruthy();
  });

  it('deleteTeam still removes its own team and roster', async () => {
    const team = await createTeam(db, principal.accountId, { name: 'Ops', slug: 'ops' });
    if (!team.ok) throw new Error('setup');
    await addTeamMember(db, principal.accountId, team.value.id, principal.memberId);
    expect((await deleteTeam(db, principal.accountId, team.value.id)).ok).toBe(true);
    const left = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM team_membership WHERE team_id = ${team.value.id}`,
    );
    expect(Number(left?.n)).toBe(0);
  });

  it("deleteEventType leaves another account's hosts in place", async () => {
    const et = await createEventType(db, victim.accountId, victim.memberId, {
      slug: 'demo',
      title: 'Demo',
      lengthMinutes: 30,
    } as never);
    if (!et.ok) throw new Error('setup');
    await db.run(
      sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, created_at)
          VALUES (${randomUUID()}, ${victim.accountId}, ${et.value.id}, ${victim.memberId}, ${Date.now()})`,
    );

    await deleteEventType(db, principal.accountId, et.value.id);

    const hosts = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM event_type_host WHERE event_type_id = ${et.value.id}`,
    );
    expect(Number(hosts?.n)).toBeGreaterThan(0);
  });
});
