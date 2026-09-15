import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createBooking, createDb, createEventType, createTeam, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { bookingViewSchema, rescheduleContextSchema } from '@slate/types';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * #122 — a team booking must be reschedulable from the manage page.
 *
 * `manageView()` built its reschedule context from a LEFT JOIN on
 * `host_member_id`, so a TEAM booking was described by the assigned organizer's
 * handle plus the TEAM event slug. That reads as a perfectly valid personal
 * context, so the manage page called the personal availability route — whose
 * lookup is `account_id + member_id + slug`, and a team event type has
 * `member_id NULL` with `team_id` set. The lookup missed, availability came
 * back empty, and the picker rendered "No open times" instead of erroring. A
 * team invitee could cancel but never reschedule.
 *
 * These assert the CONTEXT the manage page routes on, and then that a team
 * booking actually moves — the two halves of the bug. The context is checked
 * against the shared `rescheduleContextSchema` rather than key-by-key, so a
 * contract edit fails here rather than in a browser.
 */
describe('team booking — manage view reschedule context (#122)', () => {
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

  /** Bookable instants on the seeded `acme` / `sales` team event, in order. */
  async function teamSlots(svc: BookingService) {
    const w = WINDOW();
    const avail = await svc.teamAvailability('acme', 'sales', 'team-demo', w.from, w.to);
    const slots = avail?.slots.map((s) => s.startUtc) ?? [];
    if (slots.length < 2) throw new Error('the seeded team event offered too few slots to move between');
    return slots;
  }

  /** Book the seeded team event and hand back the view plus its manage token. */
  async function bookTeam(svc: BookingService, startUtc: string) {
    const out = await svc.teamBook('acme', 'sales', { slug: 'team-demo', startUtc, attendee });
    if ('error' in out) throw new Error(`teamBook failed: ${out.error}`);
    const token = new URL(out.manageUrl!).searchParams.get('token');
    if (!token) throw new Error('teamBook returned no manage token');
    return { booking: out, token };
  }

  /** The manage view for a uid+token, failing loudly rather than returning an error shape. */
  async function manageView(svc: BookingService, uid: string, token: string) {
    const view = await svc.manageView(uid, token);
    if ('error' in view) throw new Error(`manageView failed: ${String(view.error)}`);
    return view;
  }

  it('describes a team booking as a TEAM context, not as the organizer', async () => {
    const svc = service();
    const { booking, token } = await bookTeam(svc, (await teamSlots(svc))[0]!);
    const view = await manageView(svc, booking.uid, token);

    const ctx = view.reschedule;
    expect(ctx).toBeDefined();
    expect(rescheduleContextSchema.safeParse(ctx).success).toBe(true);
    // The whole bug in one assertion: the context must NOT name the organizer,
    // because the organizer's handle cannot address a team event type.
    expect(ctx).toEqual({
      kind: 'team',
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
    });
    expect(ctx).not.toHaveProperty('handle');
  });

  it('pins the cause: the organizer handle cannot resolve the team event', async () => {
    const svc = service();
    const { booking } = await bookTeam(svc, (await teamSlots(svc))[0]!);

    // This is exactly what the manage page used to ask, built from the old
    // context. If a future edit ever makes the PERSONAL route resolve a team
    // event type, this fails and the test above stops being a real guard.
    const asPersonal = await svc.availability({
      accountCode: 'acme',
      handle: booking.host.handle,
      slug: 'team-demo',
      ...WINDOW(),
    });
    expect(asPersonal).toBeNull();
  });

  it('routes to a team availability lookup that actually offers slots', async () => {
    const svc = service();
    const { booking, token } = await bookTeam(svc, (await teamSlots(svc))[0]!);
    const ctx = (await manageView(svc, booking.uid, token)).reschedule;
    if (!ctx || ctx.kind !== 'team') throw new Error('expected a team reschedule context');

    // Drive the route the manage page picks FROM the context, so the picker's
    // empty state can only come back if the event is genuinely fully booked.
    const w = WINDOW();
    const avail = await svc.teamAvailability(ctx.accountCode, ctx.teamSlug, ctx.slug, w.from, w.to);
    expect(avail).not.toBeNull();
    expect(avail!.slots.length).toBeGreaterThan(0);
  });

  it('reschedules a team booking, in place and to the new time', async () => {
    const svc = service();
    const slots = await teamSlots(svc);
    const { booking, token } = await bookTeam(svc, slots[0]!);
    const target = slots[1]!;

    // The seed ships a booking of its own, so count the DELTA rather than the
    // table: what matters is that a reschedule MOVES a row and mints none.
    const countAll = async () =>
      (await db.all<{ id: string }>(sql`SELECT id FROM booking`)).length;
    const before = await countAll();

    const moved = await svc.reschedule(booking.uid, { newStartUtc: target, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);

    expect(moved.uid).toBe(booking.uid);
    expect(new Date(moved.startUtc).getTime()).toBe(new Date(target).getTime());
    // A real move ROTATES the manage token, so the page gets a live link back.
    expect(moved.manageUrl).toBeTruthy();

    // It MOVED — it did not mint a second booking. The manage page's own QA
    // question ("did the booking move, and is there only one row?") asserted.
    const rows = await db.all<{ id: string; start_ms: number; status: string }>(
      sql`SELECT id, start_ms, status FROM booking WHERE uid = ${booking.uid}`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.start_ms)).toBe(new Date(target).getTime());
    expect(rows[0]!.status).toBe('accepted');

    expect(await countAll()).toBe(before);
  });

  it('keeps the rotated token usable and the view coherent after the move', async () => {
    const svc = service();
    const slots = await teamSlots(svc);
    const { booking, token } = await bookTeam(svc, slots[0]!);
    const target = slots[1]!;

    const moved = await svc.reschedule(booking.uid, { newStartUtc: target, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);
    const rotated = new URL(moved.manageUrl!).searchParams.get('token')!;

    const after = await manageView(svc, booking.uid, rotated);
    expect(bookingViewSchema.safeParse(after).success).toBe(true);
    expect(new Date(after.startUtc).getTime()).toBe(new Date(target).getTime());
    // Still a team booking after the move — so a second reschedule routes right.
    expect(after.reschedule).toMatchObject({ kind: 'team', teamSlug: 'sales' });
  });

  it('answers NO context when the team has no slug, rather than the organizer', async () => {
    const svc = service();
    const { booking, token } = await bookTeam(svc, (await teamSlots(svc))[0]!);

    // `team.slug` is nullable in both dialects. Such a team is not addressable
    // on any public route — and falling back to the organizer's handle would
    // emit exactly the personal-shaped context that caused #122, sending the
    // page to a lookup that cannot see a team event type.
    await db.run(sql`UPDATE team SET slug = NULL WHERE slug = 'sales'`);

    expect((await manageView(svc, booking.uid, token)).reschedule).toBeUndefined();
  });

  it('still describes a PERSONAL booking by its handle', async () => {
    const svc = service();
    // A personal event with no intake questions — the seeded `intro-call` asks
    // required ones, and this is about the CONTEXT shape, not about intake.
    const account = await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`);
    const alex = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    const ev = await createEventType(db, account!.id, alex!.id, {
      slug: 'manage-personal',
      title: 'manage-personal',
      lengthMinutes: 30,
      scheduleId: null,
    });
    if (!ev.ok) throw new Error('event create failed');

    const avail = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'manage-personal',
      ...WINDOW(),
    });
    const startUtc = avail?.slots[0]?.startUtc;
    if (!startUtc) throw new Error('the personal event offered no slots');

    const out = await svc.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'manage-personal',
      startUtc,
      attendee,
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    const token = new URL(out.manageUrl!).searchParams.get('token')!;

    const ctx = (await manageView(svc, out.uid, token)).reschedule;
    expect(rescheduleContextSchema.safeParse(ctx).success).toBe(true);
    expect(ctx).toMatchObject({ accountCode: 'acme', handle: 'alex-rivera', slug: 'manage-personal' });
    expect(ctx).not.toHaveProperty('teamSlug');

    // And it still reschedules through the personal route it names.
    const target = avail!.slots[1]?.startUtc;
    if (!target) throw new Error('the personal event offered too few slots to move between');
    const moved = await svc.reschedule(out.uid, { newStartUtc: target, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);
    expect(new Date(moved.startUtc).getTime()).toBe(new Date(target).getTime());
  });

});

/**
 * #129 + #127 — what a reschedule MEANS per scheduling method, at the service
 * seam the manage page actually drives.
 *
 * #129: a collective booking assigns every host, and `createTeamBooking` guards
 * overlap for all of them. The reschedule path checked the organizer alone, so
 * a manage-token holder could POST a move that double-booked a co-host — one
 * create time would have refused, and one the Postgres `booking_no_overlap`
 * EXCLUDE cannot catch, because a co-host conflict is a different tuple.
 *
 * #127: the same host set, read from the picker's side. The public team route
 * answers what the event offers a NEW invitee — for round-robin the UNION
 * across hosts — while the reschedule keeps the assigned organizer, so the
 * picker listed times the write refused with a 400. The manage page now asks
 * `rescheduleAvailability`, scoped to the booking's own hosts.
 */
describe('team reschedule — the assigned host set (#129, #127)', () => {
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
    to: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  });

  const attendee = { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  /** A team + team event of the given method, hosted by Alex and Jordan. */
  async function makeTeamEvent(slug: string, schedulingType: 'round_robin' | 'collective') {
    const team = await createTeam(db, accountId, { name: slug, slug: `${slug}-team` });
    if (!team.ok) throw new Error('team create failed');
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType,
      scheduleId: null,
      teamId: team.value.id,
    });
    if (!ev.ok) throw new Error('event create failed');
    for (const memberId of [alexId, jordanId]) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, ${0}, ${null}, ${100}, ${null}, ${Date.now()})`,
      );
    }
    return { teamSlug: `${slug}-team`, slug };
  }

  async function bookTeamEvent(svc: BookingService, t: { teamSlug: string; slug: string }, startUtc: string) {
    const out = await svc.teamBook('acme', t.teamSlug, { slug: t.slug, startUtc, attendee });
    if ('error' in out) throw new Error(`teamBook failed: ${out.error}`);
    const token = new URL(out.manageUrl!).searchParams.get('token');
    if (!token) throw new Error('teamBook returned no manage token');
    return { booking: out, token };
  }

  const publicSlots = async (svc: BookingService, t: { teamSlug: string; slug: string }) => {
    const w = WINDOW();
    const r = await svc.teamAvailability('acme', t.teamSlug, t.slug, w.from, w.to);
    return (r?.slots ?? []).map((s) => s.startUtc);
  };

  /**
   * Instants BOTH hosts are free at — a collective probe over the same two
   * hosts, whose availability is their intersection. A round-robin event's own
   * slots are a UNION, so a target taken from them can be a time only one host
   * is free at, and the divergence the #127 spec sets up would collapse to
   * "both busy" instead of "one free".
   */
  const bothFreeSlots = async (svc: BookingService, probeSlug: string) =>
    publicSlots(svc, await makeTeamEvent(probeSlug, 'collective'));

  const pickerSlots = async (svc: BookingService, uid: string, token: string) => {
    const w = WINDOW();
    const r = await svc.rescheduleAvailability(uid, token, { from: w.from, to: w.to });
    return (r?.slots ?? []).map((s) => s.startUtc);
  };

  /** Occupy a member at `startUtc` with a personal booking of their own. */
  async function occupy(memberId: string, handle: string, slug: string, startUtc: string) {
    await createEventType(db, accountId, memberId, { slug, title: slug, lengthMinutes: 30, scheduleId: null });
    const busy = await createBooking(db, {
      accountCode: 'acme',
      handle,
      slug,
      startMs: new Date(startUtc).getTime(),
      attendee: { name: 'Other', email: `other-${slug}@example.com`, timeZone: 'America/New_York' },
    });
    if (!busy.ok) throw new Error('could not occupy the host');
  }

  const startOf = (uid: string) =>
    db.get<{ start_ms: number; host_member_id: string }>(
      sql`SELECT start_ms, host_member_id FROM booking WHERE uid = ${uid}`,
    );

  it('refuses a collective move that would double-book a co-host (#129)', async () => {
    const svc = service();
    const collab = await makeTeamEvent('collab', 'collective');
    const slots = await publicSlots(svc, collab);
    const { booking, token } = await bookTeamEvent(svc, collab, slots[0]!);
    const target = slots[1]!;

    const row = (await startOf(booking.uid))!;
    const coHostId = row.host_member_id === alexId ? jordanId : alexId;
    await occupy(coHostId, coHostId === alexId ? 'alex-rivera' : 'jordan-lee', 'cohost-busy', target);

    const moved = await svc.reschedule(booking.uid, { newStartUtc: target, token });
    expect('error' in moved).toBe(true);
    // Refused, and NOT half-applied: the booking is where it was.
    expect(Number((await startOf(booking.uid))!.start_ms)).toBe(new Date(slots[0]!).getTime());
  });

  it('moves a clean collective booking and keeps every assigned host on it (#129)', async () => {
    const svc = service();
    const collab = await makeTeamEvent('collab', 'collective');
    const slots = await publicSlots(svc, collab);
    const { booking, token } = await bookTeamEvent(svc, collab, slots[0]!);
    const target = slots[1]!;

    const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${booking.uid}`))!.id;
    const hostsOf = async () =>
      (await db.all<{ member_id: string }>(sql`SELECT member_id FROM booking_host WHERE booking_id = ${bookingId}`))
        .map((r) => r.member_id)
        .sort();
    const before = await hostsOf();
    expect(before).toEqual([alexId, jordanId].sort());

    const moved = await svc.reschedule(booking.uid, { newStartUtc: target, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);
    expect(new Date(moved.startUtc).getTime()).toBe(new Date(target).getTime());
    expect(await hostsOf()).toEqual(before);
  });

  it('round-robin: the manage picker stops offering what the write refuses (#127)', async () => {
    const svc = service();
    const rr = await makeTeamEvent('rr', 'round_robin');
    const slots = await bothFreeSlots(svc, 'rr-probe');
    const { booking, token } = await bookTeamEvent(svc, rr, slots[0]!);
    const target = slots[1]!;

    // Make the hosts diverge — with identical seeded schedules the union and
    // the organizer's own hours coincide and the bug cannot show.
    const row = (await startOf(booking.uid))!;
    await occupy(
      row.host_member_id,
      row.host_member_id === alexId ? 'alex-rivera' : 'jordan-lee',
      'organizer-busy',
      target,
    );

    // The public team route still lists it (union: the other host is free) —
    // which is exactly what the manage page used to ask, and the 400 it showed.
    expect(await publicSlots(svc, rr)).toContain(target);
    expect('error' in (await svc.reschedule(booking.uid, { newStartUtc: target, token }))).toBe(true);

    // The booking-scoped picker does not offer it, and what it does offer moves.
    const offered = await pickerSlots(svc, booking.uid, token);
    expect(offered).not.toContain(target);
    expect(offered.length).toBeGreaterThan(0);
    const moved = await svc.reschedule(booking.uid, { newStartUtc: offered[0]!, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);
    expect(new Date(moved.startUtc).getTime()).toBe(new Date(offered[0]!).getTime());
  });

  it('token-gates the reschedule picker, and hides whether the uid exists', async () => {
    const svc = service();
    const rr = await makeTeamEvent('rr', 'round_robin');
    const { booking, token } = await bookTeamEvent(svc, rr, (await publicSlots(svc, rr))[0]!);
    const w = WINDOW();
    expect(await svc.rescheduleAvailability(booking.uid, 'not-the-token', { from: w.from, to: w.to })).toBeNull();
    expect(await svc.rescheduleAvailability('no-such-uid', token, { from: w.from, to: w.to })).toBeNull();
    // A malformed window is a 400, not a 500 out of the slot engine.
    await expect(svc.rescheduleAvailability(booking.uid, token, { from: 'x', to: 'y' })).rejects.toThrow();
  });

  it('still answers a PERSONAL booking\u2019s picker, host-scoped as before', async () => {
    const svc = service();
    const ev = await createEventType(db, accountId, alexId, {
      slug: 'personal-picker',
      title: 'personal-picker',
      lengthMinutes: 30,
      scheduleId: null,
    });
    if (!ev.ok) throw new Error('event create failed');
    const avail = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'personal-picker',
      ...WINDOW(),
    });
    const startUtc = avail!.slots[0]!.startUtc;
    const out = await svc.book({ accountCode: 'acme', handle: 'alex-rivera', slug: 'personal-picker', startUtc, attendee });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    const token = new URL(out.manageUrl!).searchParams.get('token')!;

    const offered = await pickerSlots(svc, out.uid, token);
    expect(offered.length).toBeGreaterThan(0);
    // Its own instant is not on offer, and every listed time actually moves it.
    expect(offered).not.toContain(startUtc);
    const moved = await svc.reschedule(out.uid, { newStartUtc: offered[0]!, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${String(moved.error)}`);
    expect(new Date(moved.startUtc).getTime()).toBe(new Date(offered[0]!).getTime());
  });
});

/**
 * Pure contract assertions — deliberately OUTSIDE the suite above, which builds
 * a SQLite database in `beforeEach`. These say something about the schema only,
 * so they must not be able to fail for a reason the schema had nothing to do
 * with (a missing fixture, a native-module mismatch).
 */
describe('reschedule context contract (#122)', () => {
  it('parses a v1 personal context, which carried no `kind` (additive)', () => {
    // A body written before the discriminant existed still means personal, so
    // an in-flight response or a cached page keeps routing to the same place.
    const v1 = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' };
    const parsed = rescheduleContextSchema.safeParse(v1);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBeUndefined();
    expect(bookingViewSchema.shape.reschedule.safeParse(v1).success).toBe(true);
  });

  it('keeps the branches disjoint, so neither shape can read as the other', () => {
    const team = { kind: 'team', accountCode: 'acme', teamSlug: 'sales', slug: 'team-demo' };
    const parsedTeam = rescheduleContextSchema.safeParse(team);
    expect(parsedTeam.success).toBe(true);
    expect(parsedTeam.success && parsedTeam.data).not.toHaveProperty('handle');

    // A team context is NOT accepted as a personal one just because `kind` is
    // optional on that branch — the personal branch requires `handle`.
    expect(rescheduleContextSchema.safeParse({ ...team, kind: undefined }).success).toBe(false);
    // …and a personal body cannot claim the team literal without a team slug.
    expect(
      rescheduleContextSchema.safeParse({
        kind: 'team',
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
      }).success,
    ).toBe(false);
  });
});
