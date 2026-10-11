import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider, InMemoryCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';

/**
 * `POST /v1/connections` stores the ref it is given. With an external provider
 * wired the adapter acts as whatever identity a ref names, so hand-written refs
 * are refused there; connections come from the connect flow. With no provider
 * (the OSS default) a manual entry is the only way to record one.
 */
describe('manual connections', () => {
  let db: Db;
  let principal: { accountId: string; memberId: string; role: 'owner' };

  const admin = (provider: CalendarProvider) =>
    new AdminService(
      db,
      new CalendarEffects(provider, db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
  const count = async () =>
    Number((await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connected_calendar`))?.n ?? 0);

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    principal = { accountId, memberId, role: 'owner' };
  });

  it('are refused when an external provider is wired, and nothing is stored', async () => {
    let error: unknown;
    try {
      admin(new InMemoryCalendarProvider()).createConnection(principal, {
        provider: 'google',
        externalId: 'any-ref-the-caller-wrote',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ error: 'CONNECT_FLOW_REQUIRED' });
    expect(await count()).toBe(0);
  });

  it('still work with no provider (the OSS default)', async () => {
    await admin(new DisabledCalendarProvider()).createConnection(principal, {
      provider: 'google',
      externalId: 'manual-ref',
    });
    expect(await count()).toBe(1);
  });
});
