import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminService } from './admin.service';
import { AuthService, type HostPrincipal, type ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { HostController } from './host.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;

/**
 * Who booked, on the dashboard's page for one booking (`GET
 * /v1/host/bookings/:uid`, `guest`): the invitee's name, email and phone, the
 * other guests, the event's questions with their answers, and the notes, the
 * way the host's copy of the booking email lists them. Only for the booking's
 * host (the member the bookings list shows it to) and its co-hosts; anyone
 * else in the account reads the booking with `guest: null`.
 */
describe("the guest on the dashboard's page for one booking", () => {
  let db: Db;
  let accountId: string;
  let alex: HostPrincipal;
  let jordan: HostPrincipal;
  let as: HostPrincipal;
  let host: HostController;
  let bookings: BookingService;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const a = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`))!;
    const j = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!;
    accountId = a.account_id;
    alex = { accountId, memberId: a.id, role: 'owner' };
    jordan = { accountId, memberId: j.id, role: 'member' };
    as = alex;
    const auth = { resolveHost: () => Promise.resolve(as) } as unknown as AuthService;
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    const admin = new AdminService(db, calendar, email);
    host = new HostController(admin, {} as never, auth, {} as never);
    bookings = new BookingService(db, ENV, calendar, email);
  });

  afterEach(async () => {
    await db.close();
  });

  /** One booking of Alex's Intro Call, which asks "company" and "topic". */
  async function bookIntro(answers: Record<string, unknown>, extra: { notes?: string; phone?: string } = {}) {
    const avail = await bookings.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      from: new Date().toISOString(),
      to: new Date(Date.now() + 14 * DAY).toISOString(),
    });
    const out = await bookings.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: avail!.slots[0]!.startUtc,
      attendee: { name: 'Sam Visitor', email: 'sam@example.org', timeZone: 'UTC', ...extra },
      answers,
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    return out.uid;
  }

  it('shows the host who booked and what they answered, as the host email does', async () => {
    const uid = await bookIntro(
      { company: 'Example Co', topic: 'Pricing\nand onboarding', stray: 'a key no question names' },
      { notes: 'Please call first', phone: '+57 300 000 0000' },
    );
    const got = await host.getBooking(REQ, uid, 'en');
    expect(got).toMatchObject({ uid, hostMemberId: alex.memberId });
    expect(got.guest).toEqual({
      name: 'Sam Visitor',
      email: 'sam@example.org',
      phone: '+57 300 000 0000',
      others: [],
      answers: [
        { label: 'Company', value: 'Example Co' },
        { label: 'What would you like to discuss?', value: 'Pricing\nand onboarding' },
        { label: 'Notes', value: 'Please call first' },
      ],
    });
  });

  it("writes the words it adds in the page's language, and the member's own without one", async () => {
    const uid = await bookIntro({ company: 'Example Co' }, { notes: 'Llamar antes' });
    const es = await host.getBooking(REQ, uid, 'es');
    expect(es.guest!.answers).toContainEqual({ label: 'Notas', value: 'Llamar antes' });
    const none = await host.getBooking(REQ, uid);
    expect(none.guest!.answers).toContainEqual({ label: 'Notes', value: 'Llamar antes' });
    await db.run(sql`UPDATE member SET locale = 'es' WHERE id = ${alex.memberId}`);
    const own = await host.getBooking(REQ, uid, 'fr');
    expect(own.guest!.answers).toContainEqual({ label: 'Notas', value: 'Llamar antes' });
  });

  it('lists the other people the booking invites, without the invitee', async () => {
    const uid = await bookIntro({ company: 'Example Co' });
    const id = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
    for (const [name, email] of [
      ['Ana Ruiz', 'ana@example.org'],
      [null, 'sam@example.org'],
    ] as const) {
      await db.run(
        sql`INSERT INTO booking_guest (id, booking_id, email, email_normalized, name, time_zone, created_at)
            VALUES (${randomUUID()}, ${id}, ${email}, ${email}, ${name}, ${null}, ${Date.now()})`,
      );
    }
    expect((await host.getBooking(REQ, uid, 'en')).guest!.others).toEqual(['Ana Ruiz (ana@example.org)']);
  });

  it('keeps them from a member who is not its host, and shows them to a co-host', async () => {
    const uid = await bookIntro({ company: 'Example Co' }, { notes: 'Private note' });
    as = jordan;
    const outsider = await host.getBooking(REQ, uid, 'en');
    expect(outsider).toMatchObject({ uid, guest: null });
    expect(JSON.stringify(outsider)).not.toMatch(/Sam Visitor|sam@example\.org|Example Co|Private note/);

    const id = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
    await db.run(
      sql`INSERT INTO booking_host (id, booking_id, member_id, is_fixed, created_at)
          VALUES (${randomUUID()}, ${id}, ${jordan.memberId}, 0, ${Date.now()})`,
    );
    expect((await host.getBooking(REQ, uid, 'en')).guest).toMatchObject({ name: 'Sam Visitor', email: 'sam@example.org' });
  });

  it("still reads nothing of another account's booking", async () => {
    const uid = await bookIntro({ company: 'Example Co' });
    as = { ...alex, accountId: 'another-account' };
    await expect(host.getBooking(REQ, uid, 'en')).rejects.toMatchObject({ status: 404 });
  });

  it('answers null for a booking without an invitee row', async () => {
    const uid = await bookIntro({ company: 'Example Co' });
    await db.run(sql`DELETE FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`);
    expect((await host.getBooking(REQ, uid, 'en')).guest).toBeNull();
  });
});
