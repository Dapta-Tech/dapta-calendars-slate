import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

const REQ: ReqLike = { headers: {} };

class FakeAuth {
  current: HostPrincipal = { accountId: '', memberId: '', role: 'member' };
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

/**
 * The brand kit's routes where they run: the workspace kit is read by every
 * member and written only by an admin or owner; "Apply kit" snapshots it into
 * the caller's own page and the studio's state says so; Revert takes it back.
 */
describe('brand kit routes', () => {
  let db: Db;
  let host: HostController;
  const auth = new FakeAuth();
  let accountId: string;
  let alex: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    const admin = new AdminService(
      db,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
    host = new HostController(admin, {} as never, auth as unknown as AuthService, {} as never);
  });

  const as = (role: HostPrincipal['role']) => {
    auth.current = { accountId, memberId: alex, role };
  };

  it('is written by an admin or owner only, and read by anyone', async () => {
    as('member');
    await expect(host.putBrandKit(REQ, { accent: '#2f6fed' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await host.getBrandKit(REQ)).toEqual({ config: null, updatedAt: null });
    as('admin');
    const saved = await host.putBrandKit(REQ, { accent: '#2f6fed', theme: 'light' });
    expect(saved.config).toEqual({ accent: '#2f6fed', theme: 'light' });
    as('member');
    expect((await host.getBrandKit(REQ)).config).toEqual({ accent: '#2f6fed', theme: 'light' });
  });

  it('refuses a kit that is not one', async () => {
    as('owner');
    await expect(host.putBrandKit(REQ, { accent: 'lime' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(host.putBrandKit(REQ, { template: 'split' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies to the caller page with a backup, and Revert takes it back', async () => {
    as('member');
    await expect(host.applyBrandKit(REQ)).rejects.toBeInstanceOf(NotFoundException);
    as('owner');
    await host.putBrandKit(REQ, { accent: '#2f6fed', corners: 'round' });
    as('member');
    const before = await db.get(sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${alex}`);
    await host.applyBrandKit(REQ);
    expect((await host.bookingPageState(REQ)).backup?.source).toBe('kit');
    await host.revertBranding(REQ);
    expect(await db.get(sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${alex}`)).toEqual(before);
    await expect(host.revertBranding(REQ)).rejects.toBeInstanceOf(NotFoundException);
  });
});
