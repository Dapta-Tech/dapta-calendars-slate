import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, createEventType, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { bookingViewSchema } from '@slate/types';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { PublicController } from './public.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * #102 — the two public write paths must answer the SAME shape.
 *
 * `POST /v1/public/teams/{account}/{team}/bookings` used to return a narrow
 * `{ uid, hostMemberId, manageUrl }` while `POST /v1/bookings` returned a full
 * `BookingView`. The web client casts a 201 body to `BookingView`, so a team
 * booking reached the confirmation with `startUtc` undefined,
 * `formatSlotDateTime` threw `RangeError: Invalid time value`, and the public
 * error boundary told every team invitee that a booking which had in fact
 * succeeded had failed.
 *
 * These assert the CONTRACT rather than the implementation: the response is
 * parsed with the shared `bookingViewSchema` instead of key-by-key, so an edit
 * that drops a field fails here rather than in a browser.
 */
describe('public team booking — response shape (#102)', () => {
  let db: Db;

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

  const attendee = { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  /** A personal event on Alex with no intake questions — the seeded `intro-call`
   *  asks required ones, and this comparison is about SHAPE, not about intake. */
  async function personalEvent(slug: string) {
    const account = await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`);
    const alex = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    const ev = await createEventType(db, account!.id, alex!.id, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
    });
    if (!ev.ok) throw new Error('event create failed');
    return slug;
  }

  /** The first bookable instant on the seeded `acme` / `sales` team event. */
  async function firstTeamSlot(svc: BookingService) {
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', 'sales', 'team-demo', w.from, w.to);
    const startUtc = avail?.slots[0]?.startUtc;
    if (!startUtc) throw new Error('the seeded team event offered no slots');
    return startUtc;
  }

  it('returns a body that parses as a BookingView', async () => {
    const svc = service();
    const out = await svc.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: await firstTeamSlot(svc),
      attendee,
    });
    if ('error' in out) throw new Error(`teamBook failed: ${out.error}`);

    // The whole bug in one assertion: the narrow shape does not parse.
    expect(bookingViewSchema.safeParse(out).success).toBe(true);
  });

  it('carries the fields the confirmation screen renders', async () => {
    const svc = service();
    const startUtc = await firstTeamSlot(svc);
    const out = await svc.teamBook('acme', 'sales', { slug: 'team-demo', startUtc, attendee });
    if ('error' in out) throw new Error(`teamBook failed: ${out.error}`);

    expect(out.title).toBeTruthy();
    expect(out.status).toBe('accepted');
    // `formatSlotDateTime(b.startUtc)` is what threw — the instant it receives
    // has to be real, and has to be the instant that was booked.
    expect(Number.isNaN(Date.parse(out.startUtc))).toBe(false);
    expect(new Date(out.startUtc).getTime()).toBe(new Date(startUtc).getTime());
    expect(Number.isNaN(Date.parse(out.endUtc))).toBe(false);
    expect(new Date(out.endUtc).getTime()).toBeGreaterThan(new Date(out.startUtc).getTime());
    expect(out.attendee).toEqual(attendee);
    expect(out.manageUrl).toBeTruthy();
  });

  it('keeps hostMemberId as an additive field, resolved to a real member', async () => {
    const svc = service();
    const out = await svc.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: await firstTeamSlot(svc),
      attendee,
    });
    if ('error' in out) throw new Error(`teamBook failed: ${out.error}`);

    expect(out.hostMemberId).toBeTruthy();
    // The organizer is a real member, so the confirmation can name a host.
    expect(out.host.handle).toBeTruthy();
  });

  it('matches the personal path field for field', async () => {
    const svc = service();
    const slug = await personalEvent('shape-personal');
    const personalAvail = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      ...WINDOW(),
    });
    const personal = await svc.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startUtc: personalAvail!.slots[0]!.startUtc,
      attendee: { ...attendee, email: 'personal@example.com' },
    });
    if ('error' in personal) throw new Error(`book failed: ${personal.error}`);

    const team = await svc.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: await firstTeamSlot(svc),
      attendee,
    });
    if ('error' in team) throw new Error(`teamBook failed: ${team.error}`);

    // `hostMemberId` is the one addition; everything the personal path answers
    // with, the team path answers with too. Keys carrying `undefined` are
    // skipped on both sides — `JSON.stringify` drops them, so they are not part
    // of what a client receives.
    const present = (o: object) =>
      Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined);
    const teamKeys = present(team);
    for (const key of present(personal)) expect(teamKeys).toContain(key);
    expect(teamKeys).toContain('hostMemberId');
  });

  it('reaches the HTTP boundary intact', async () => {
    const svc = service();
    const controller = new PublicController(svc);
    const body = await controller.teamBook('acme', 'sales', {
      slug: 'team-demo',
      startUtc: await firstTeamSlot(svc),
      attendee: attendee as never,
    });

    // What the browser actually receives, after `unwrap()`.
    expect(bookingViewSchema.safeParse(body).success).toBe(true);
  });
});
