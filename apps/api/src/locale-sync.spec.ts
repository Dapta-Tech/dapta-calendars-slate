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
 * The host's own language (`member.locale`). Nothing wrote it, so every host
 * had none and their booking link previewed in English in every chat. The
 * dashboard now records the language it is shown in, once (`me/locale-sync`),
 * and the language switch saves an explicit choice (`PATCH me/settings`).
 */
describe('the host language', () => {
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
      resolveHost: async (_req: ReqLike) => ({ accountId: account!.id, memberId, role: 'owner' as const }),
    } as unknown as AuthService;
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    ctrl = new HostController(new AdminService(db, calendar, email), new OnboardingService(db), auth, new GrowthService(db));
  });

  const req = {} as ReqLike;
  const stored = async () =>
    (await db.get<{ locale: string | null }>(sql`SELECT locale FROM member WHERE id = ${memberId}`))!.locale;

  it('records the dashboard language while the host has none', async () => {
    expect(await stored()).toBeNull();
    expect(await ctrl.syncLocale(req, { locale: 'es' })).toEqual({ ok: true });
    expect(await stored()).toBe('es');
  });

  it('never overwrites a language already on record', async () => {
    await ctrl.updateSettings(req, { locale: 'en' });
    await ctrl.syncLocale(req, { locale: 'es' });
    expect(await stored()).toBe('en');
  });

  it('ignores anything but en or es', async () => {
    expect(await ctrl.syncLocale(req, { locale: 'fr' })).toEqual({ ok: false });
    expect(await ctrl.syncLocale(req, {})).toEqual({ ok: false });
    expect(await stored()).toBeNull();
  });

  it('saves an explicit choice from the language switch, and refuses an unknown one', async () => {
    await ctrl.updateSettings(req, { locale: 'es' });
    expect(await stored()).toBe('es');
    await expect(ctrl.updateSettings(req, { locale: 'fr' })).rejects.toMatchObject({ status: 400 });
    expect(await stored()).toBe('es');
    await ctrl.updateSettings(req, { locale: null });
    expect(await stored()).toBeNull();
  });
});
