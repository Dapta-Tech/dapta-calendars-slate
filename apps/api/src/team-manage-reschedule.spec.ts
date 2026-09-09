import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, createEventType, type Db } from '@slate/db';
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

  it('parses a v1 personal context, which carried no `kind` (additive contract)', () => {
    // A body written before the discriminant existed still means personal, so
    // an in-flight response or a cached page keeps routing to the same place.
    const v1 = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' };
    const parsed = rescheduleContextSchema.safeParse(v1);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBeUndefined();
    expect(bookingViewSchema.shape.reschedule.safeParse(v1).success).toBe(true);
  });
});
