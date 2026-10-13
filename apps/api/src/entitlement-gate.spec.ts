import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { cacheEntitlement, createDb, migrate, seed, setHideBranding, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { ENTITLEMENT_TTL_MS } from '@slate/shared';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import { BookingService } from './booking.service';
import { EntitlementGate, entitlementGateProvider } from './entitlement-gate';
import type { EntitlementAnswer, EntitlementsProvider } from './entitlements.provider';
import { CALENDAR, DB, EMAIL, ENTITLEMENT_GATE, ENTITLEMENTS, ENV, NOTIFIER, PREMIUM_MODE } from './tokens';

/**
 * The app registers ONE EntitlementGate and every service injects it, so "one
 * upstream call per account at a time" holds across the public pages, the
 * emails and Settings, not only inside one service.
 */

/** An upstream that answers only when the test lets it, so calls overlap. */
class HeldUpstream implements EntitlementsProvider {
  readonly enabled = true;
  calls = 0;
  private release!: () => void;
  private readonly held = new Promise<void>((r) => (this.release = r));
  async verdict(): Promise<EntitlementAnswer> {
    this.calls++;
    await this.held;
    return 'paid';
  }
  answer() {
    this.release();
  }
}

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

describe('one entitlement gate for the whole app', () => {
  let db: Db;
  let app: INestApplicationContext;
  let upstream: HeldUpstream;
  let accountId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    upstream = new HeldUpstream();

    @Module({
      providers: [
        { provide: DB, useValue: db },
        { provide: ENV, useValue: loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv) },
        { provide: EMAIL, useValue: new NoopEmailProvider() },
        { provide: NOTIFIER, useValue: new BookingNotifier(new NoopEmailProvider()) },
        { provide: CALENDAR, useValue: new DisabledCalendarProvider() },
        { provide: ENTITLEMENTS, useValue: upstream },
        { provide: PREMIUM_MODE, useValue: 'locked' },
        entitlementGateProvider,
        CalendarEffects,
        EmailEffects,
        BookingService,
        AdminService,
      ],
    })
    class TestModule {}
    app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('the public pages, the emails and Settings all hold the same gate', () => {
    const gate = app.get<EntitlementGate>(ENTITLEMENT_GATE);
    expect(gate).toBeInstanceOf(EntitlementGate);
    for (const svc of [app.get(BookingService), app.get(EmailEffects), app.get(AdminService)]) {
      expect((svc as unknown as { gate: EntitlementGate }).gate).toBe(gate);
    }
  });

  it('a stale verdict read by all three at once makes one upstream call', async () => {
    await setHideBranding(db, accountId, true);
    await cacheEntitlement(db, accountId, 'paid');
    vi.setSystemTime(T0 + ENTITLEMENT_TTL_MS + 1);

    // Settings refreshes inline (and waits); the page and the email decide
    // from the cache and start a refresh on the side. All three overlap.
    const settings = app.get(AdminService).brandingStatus({ accountId, memberId: '', role: 'owner' });
    const page = app.get(BookingService).profile('acme', 'alex-rivera');
    const mail = app.get(EmailEffects).deliver(
      'confirmation',
      JSON.stringify({
        accountId,
        title: 'Intro call',
        startUtc: '2026-10-20T15:00:00.000Z',
        endUtc: '2026-10-20T15:30:00.000Z',
        host: { name: 'Alex Rivera', email: 'host@example.test' },
        attendee: { name: 'Sam Guest', email: 'guest@example.test', timeZone: 'UTC' },
        audience: 'attendee',
      }),
    );
    await Promise.all([page, mail]);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    upstream.answer();
    expect((await settings).canHide).toBe(true);
    expect(upstream.calls).toBe(1);
  });
});
