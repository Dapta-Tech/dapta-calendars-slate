import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { HostController } from './host.controller';
import { AdminService } from './admin.service';
import { OnboardingService } from './onboarding.service';
import { GrowthService } from './growth.service';
import type { AuthService, ReqLike } from './auth.service';

/**
 * QA fix 1 — timezone validation. A free-text zone ("UT}fg") used to reach the
 * DB through PATCH /v1/me/settings and crash every page that formats times
 * for that member. The write paths must reject anything Intl can't format.
 */
describe('timezone validation (QA fix 1)', () => {
  let db: Db;
  let ctrl: HostController;
  let memberId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const account = await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`);
    const member = await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${account!.id} ORDER BY created_at ASC LIMIT 1`,
    );
    memberId = member!.id;
    const auth = {
      resolveHost: async (_req: ReqLike) => ({
        accountId: account!.id,
        memberId,
        role: 'owner' as const,
      }),
    } as unknown as AuthService;
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    ctrl = new HostController(new AdminService(db, calendar, email), new OnboardingService(db), auth, new GrowthService(db));
  });

  const req = {} as ReqLike;

  it('rejects the exact corrupt value from QA with 400', async () => {
    await expect(ctrl.updateSettings(req, { timeZone: 'UT}fg' })).rejects.toMatchObject({
      status: 400,
    });
    const row = await db.get<{ time_zone: string }>(
      sql`SELECT time_zone FROM member WHERE id = ${memberId}`,
    );
    expect(row!.time_zone).not.toBe('UT}fg'); // nothing persisted
  });

  it('rejects empty and nonsense zones', async () => {
    await expect(ctrl.updateSettings(req, { timeZone: '' })).rejects.toMatchObject({ status: 400 });
    await expect(ctrl.updateSettings(req, { timeZone: 'Not/AZone' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('accepts real zones and aliases, and persists them', async () => {
    await ctrl.updateSettings(req, { timeZone: 'America/Mexico_City' });
    let row = await db.get<{ time_zone: string }>(
      sql`SELECT time_zone FROM member WHERE id = ${memberId}`,
    );
    expect(row!.time_zone).toBe('America/Mexico_City');

    await ctrl.updateSettings(req, { timeZone: 'US/Eastern' }); // alias must pass
    row = await db.get<{ time_zone: string }>(
      sql`SELECT time_zone FROM member WHERE id = ${memberId}`,
    );
    expect(row!.time_zone).toBe('US/Eastern');
  });

  it('leaves timezone untouched when patching other fields', async () => {
    await ctrl.updateSettings(req, { displayName: 'Renamed' });
    const row = await db.get<{ time_zone: string; display_name: string }>(
      sql`SELECT time_zone, display_name FROM member WHERE id = ${memberId}`,
    );
    expect(row!.display_name).toBe('Renamed');
  });
});
