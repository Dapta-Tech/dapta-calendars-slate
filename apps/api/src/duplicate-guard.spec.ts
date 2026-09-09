import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, migrate, seed, sql, createTeam, createEventType, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { PublicController } from './public.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * Duplicate-booking guard (#69 / AB1) at the API boundary: the repository
 * outcome must surface as `409 DUPLICATE_BOOKING` on BOTH public write paths,
 * and the body a blocked booker receives must not disclose the existing
 * booking's slot.
 *
 * The fixtures are built here rather than reusing the seeded `intro-call` and
 * `sales` team, so intake questions and seeded rows cannot colour the result.
 */
describe('duplicate-booking guard — API mapping', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  const service = () =>
    new BookingService(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );

  const WINDOW = () => ({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });

  const attendee = { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  /** A personal event on Alex with the host's switch on and no intake questions. */
  async function personalEvent(slug: string) {
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      preventDuplicateBookings: true,
    });
    if (!ev.ok) throw new Error('event create failed');
    return slug;
  }

  /** A round-robin team event over Alex + Jordan with the switch on. */
  async function teamEvent(slug: string) {
    const teamSlug = `${slug}-team`;
    const team = await createTeam(db, accountId, { name: slug, slug: teamSlug });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType: 'round_robin',
      scheduleId: null,
      teamId: team.value.id,
      preventDuplicateBookings: true,
    });
    if (!ev.ok) throw new Error('event create failed');
    const now = Date.now();
    for (const memberId of [alexId, jordanId]) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, 0, NULL, 100, NULL, ${now})`,
      );
    }
    return { teamSlug, slug };
  }

  /** A time-like token in the payload would mean the error leaks the booking. */
  function expectNoSlotDetail(payload: unknown) {
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // an ISO date
    expect(text).not.toMatch(/\d{1,2}:\d{2}/); // a clock time
    expect(text).not.toMatch(/startUtc|endUtc|start_ms|end_ms/);
  }

  it('personal path: a second booking from one email is 409 DUPLICATE_BOOKING with no slot detail', async () => {
    const svc = service();
    const slug = await personalEvent('ab1-personal');
    const avail = await svc.availability({ accountCode: 'acme', handle: 'alex-rivera', slug, ...WINDOW() });
    const slots = avail!.slots;
    const body = (startUtc: string) => ({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startUtc,
      attendee,
    });

    expect('error' in (await svc.book(body(slots[0]!.startUtc)))).toBe(false);

    const second = await svc.book(body(slots[1]!.startUtc));
    expect(second).toMatchObject({ error: 'DUPLICATE_BOOKING', status: 409 });
    expectNoSlotDetail(second);
  });

  it('personal path: an API-key write is exempt even when it reports onBehalf: false', async () => {
    const svc = service();
    const slug = await personalEvent('ab1-apikey');
    const avail = await svc.availability({ accountCode: 'acme', handle: 'alex-rivera', slug, ...WINDOW() });
    const slots = avail!.slots;
    const body = (startUtc: string) => ({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startUtc,
      attendee,
    });

    expect('error' in (await svc.book(body(slots[0]!.startUtc)))).toBe(false);
    // The v2 compatibility surface's exact call shape: an API-key write
    // that deliberately reports `onBehalf: false`.
    const viaKey = await svc.book(body(slots[1]!.startUtc), false, { apiKeyWrite: true });
    expect('error' in viaKey).toBe(false);
  });

  it('team path: a second booking from one email is 409 DUPLICATE_BOOKING with no slot detail', async () => {
    const svc = service();
    const t = await teamEvent('ab1-team-event');
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to);
    const slots = avail!.slots;
    const body = (startUtc: string) => ({ slug: t.slug, startUtc, attendee });

    expect('error' in (await svc.teamBook('acme', t.teamSlug, body(slots[0]!.startUtc)))).toBe(false);

    const second = await svc.teamBook('acme', t.teamSlug, body(slots[1]!.startUtc));
    expect(second).toMatchObject({ error: 'DUPLICATE_BOOKING', status: 409 });
    expectNoSlotDetail(second);
  });

  it('team path: an API-key write is exempt', async () => {
    const svc = service();
    const t = await teamEvent('ab1-team-apikey');
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to);
    const slots = avail!.slots;
    const body = (startUtc: string) => ({ slug: t.slug, startUtc, attendee });

    expect('error' in (await svc.teamBook('acme', t.teamSlug, body(slots[0]!.startUtc)))).toBe(false);
    // The exemption travels as CONTEXT — a third argument only an
    // API-key-authenticated controller supplies — never on the body.
    const viaKey = await svc.teamBook('acme', t.teamSlug, body(slots[1]!.startUtc), {
      apiKeyWrite: true,
    });
    expect('error' in viaKey).toBe(false);
  });

  it('team path: an unauthenticated booker cannot switch the guard off from the request body', async () => {
    // PublicController hands `@Body()` to the service verbatim and the app
    // installs no global ValidationPipe, so an exemption flag living on that
    // object would be settable by anyone who can POST. It must be ignored.
    const svc = service();
    const controller = new PublicController(svc);
    const t = await teamEvent('ab1-team-bodyflag');
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to);
    const slots = avail!.slots;
    const body = (startUtc: string) =>
      ({ slug: t.slug, startUtc, attendee, apiKeyWrite: true }) as never;

    await controller.teamBook('acme', t.teamSlug, body(slots[0]!.startUtc));

    await expect(controller.teamBook('acme', t.teamSlug, body(slots[1]!.startUtc))).rejects.toMatchObject({
      status: 409,
      response: { error: 'DUPLICATE_BOOKING' },
    });
  });

  it('team path: an unauthenticated booker cannot block someone else by naming them a co-attendee', async () => {
    // `additionalAttendees` land in `booking_attendee`, which is what the guard
    // matches on — so if the public route forwarded that field, anyone could
    // POST a victim's address and lock them out of the event. The route must
    // pass an explicit pick, not the raw body.
    const svc = service();
    const controller = new PublicController(svc);
    const t = await teamEvent('ab1-team-injection');
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to);
    const slots = avail!.slots;

    await controller.teamBook('acme', t.teamSlug, {
      slug: t.slug,
      startUtc: slots[0]!.startUtc,
      attendee: { name: 'Mallory', email: 'mallory@example.com', timeZone: 'America/New_York' },
      additionalAttendees: [
        { name: 'Victim', email: 'victim@example.com', timeZone: 'America/New_York' },
      ],
    } as never);

    // The victim was never written as an attendee, so their own booking lands.
    const victim = await controller.teamBook('acme', t.teamSlug, {
      slug: t.slug,
      startUtc: slots[1]!.startUtc,
      attendee: { name: 'Victim', email: 'victim@example.com', timeZone: 'America/New_York' },
    } as never);
    expect(victim).toMatchObject({ uid: expect.any(String) });
  });
});
