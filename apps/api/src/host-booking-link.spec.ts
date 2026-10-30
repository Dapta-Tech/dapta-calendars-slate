import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { createDb, listBookings, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

const REQ: ReqLike = { headers: {} };
const HOUR = 3_600_000;

class FakeAuth {
  current: HostPrincipal = { accountId: '', memberId: '', role: 'member' };
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

/**
 * The page the host's request email opens (`GET /v1/host/bookings/:uid`). It
 * answers for ONE booking by uid, so it holds whatever the list's first page
 * leaves out, and only inside the caller's account: another tenant's uid is
 * the same 404 as one that does not exist.
 */
describe('one booking for the dashboard page the request email opens', () => {
  let db: Db;
  let host: HostController;
  const auth = new FakeAuth();
  let alex: HostPrincipal;
  let other: HostPrincipal;

  async function insertBooking(
    who: HostPrincipal,
    opts: { title: string; startMs: number; status?: string },
  ): Promise<string> {
    const uid = randomUUID();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms,
            status, metadata, created_at, updated_at)
          VALUES (${randomUUID()}, ${who.accountId}, ${uid}, ${null}, ${who.memberId}, ${opts.title},
            ${opts.startMs}, ${opts.startMs + HOUR / 2}, ${opts.status ?? 'accepted'}, ${null}, ${now}, ${now})`,
    );
    return uid;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    alex = { accountId, memberId, role: 'owner' };

    other = { accountId: randomUUID(), memberId: randomUUID(), role: 'owner' };
    const now = Date.now();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${other.accountId}, ${'other'}, ${'Other Co.'}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, role, created_at)
          VALUES (${other.memberId}, ${other.accountId}, ${'other-host'}, ${'Other Host'}, ${'other@example.com'}, ${'owner'}, ${now})`,
    );

    const admin = new AdminService(
      db,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );
    host = new HostController(admin, {} as never, auth as unknown as AuthService, {} as never);
  });

  it('opens a pending request the list never reaches, in the shape the list uses plus its campaign', async () => {
    // The request is the OLDEST booking, so 205 later ones push it past the 200
    // the bookings page asks for.
    const base = Date.now() + 2 * 86_400_000;
    const uid = await insertBooking(alex, { title: 'The request', startMs: base, status: 'pending' });
    for (let i = 1; i <= 205; i++) {
      await insertBooking(alex, { title: `Later ${i}`, startMs: base + i * HOUR, status: 'cancelled' });
    }
    const { items } = await listBookings(db, { accountId: alex.accountId, memberId: alex.memberId, limit: 200 });
    expect(items).toHaveLength(200);
    expect(items.some((b) => b.uid === uid)).toBe(false);

    auth.current = alex;
    expect(await host.getBooking(REQ, uid)).toEqual({
      uid,
      status: 'pending',
      title: 'The request',
      startUtc: new Date(base).toISOString(),
      endUtc: new Date(base + HOUR / 2).toISOString(),
      hostMemberId: alex.memberId,
      // No campaign on this booking (booking-utm-visible.spec.ts reads one).
      utm: null,
    });
  });

  it("answers 404 for another account's booking, exactly as for one that does not exist", async () => {
    const theirs = await insertBooking(other, { title: 'Not yours', startMs: Date.now() + 86_400_000 });
    auth.current = alex;

    const foreign = await host.getBooking(REQ, theirs).catch((e: unknown) => e);
    const missing = await host.getBooking(REQ, randomUUID()).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    // Same status, same body: nothing tells the two apart, and nothing of the
    // other tenant's booking is in the answer.
    expect((foreign as NotFoundException).getResponse()).toEqual((missing as NotFoundException).getResponse());
    expect(JSON.stringify((foreign as NotFoundException).getResponse())).not.toContain('Not yours');

    // Its own host still opens it.
    auth.current = other;
    expect((await host.getBooking(REQ, theirs)).title).toBe('Not yours');
  });

  it("opens for anyone in the booking's account, the same scope confirm and decline act in", async () => {
    // A co-host gets the same request email, so the page cannot be the
    // organizer's alone. Jordan is a second member of the same account.
    const jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    const uid = await insertBooking(alex, { title: 'Shared', startMs: Date.now() + 86_400_000, status: 'pending' });
    auth.current = { accountId: alex.accountId, memberId: jordan, role: 'member' };
    expect((await host.getBooking(REQ, uid)).uid).toBe(uid);
  });
});
