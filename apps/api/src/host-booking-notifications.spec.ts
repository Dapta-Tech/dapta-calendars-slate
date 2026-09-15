import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, createWebhook, loadEncryptionKey, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import type { HostPrincipal } from './auth.service';

/** W (#75): webhook signing secrets are enveloped; the write path needs a key. */
const WEBHOOK_KEY = loadEncryptionKey(randomBytes(32).toString('base64'));

/**
 * QA2 BUG-1 — a booking created from the admin dashboard produced NO outbox
 * rows: no attendee email, no reminders, no booking.created webhook, while the
 * success screen said "the attendee has been notified". hostCreate must mirror
 * the public create path's side-effects (idempotent replays excluded).
 */
describe('host-created bookings notify (QA2 BUG-1)', () => {
  let db: Db;
  let svc: AdminService;
  let p: HostPrincipal;
  let slug: string;
  let answers: Record<string, string> | undefined;
  /**
   * An instant `days` past the end of the seed's latest-ending booking, which
   * therefore clears every booking the seed planted (see below).
   */
  let freeSlotUtc: (days: number) => string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const account = await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`);
    const member = await db.get<{ id: string; handle: string }>(
      sql`SELECT id, handle FROM member WHERE account_id = ${account!.id} AND handle='alex-rivera'`,
    );
    // Satisfy whatever REQUIRED intake questions the seeded event carries —
    // this spec exercises notification side-effects, not intake validation.
    const et = await db.get<{ slug: string; booking_fields: string | null }>(
      sql`SELECT slug, booking_fields FROM event_type WHERE account_id = ${account!.id} AND member_id = ${member!.id} ORDER BY created_at ASC LIMIT 1`,
    );
    slug = et!.slug;
    const fields = et!.booking_fields
      ? (JSON.parse(et!.booking_fields) as Array<{ name: string; required?: boolean }>)
      : [];
    const required = fields.filter((f) => f.required);
    answers = required.length
      ? Object.fromEntries(required.map((f) => [f.name, 'qa']))
      : undefined;
    p = { accountId: account!.id, memberId: member!.id, role: 'owner' } as HostPrincipal;
    // #159 — the seed deliberately plants an accepted booking at the next
    // weekday 10:00 America/New_York so the overlap guard has something to
    // catch. Booking a whole number of days from "now" walks straight into it
    // once a week: on a Friday, "now + 3 days" and "the next weekday" are the
    // same Monday, and the two collide for the hour around 10:00 New York.
    // Anchor every slot this spec books to the seeded booking instead, so it
    // is clear of it whatever day and time the wall clock happens to read.
    const busy = await db.get<{ end_ms: number | string }>(
      sql`SELECT MAX(end_ms) AS end_ms FROM booking WHERE account_id = ${account!.id}`,
    );
    const lastBusyEndMs = Number(busy!.end_ms);
    // Name the real cause if the seed ever stops planting that booking: without
    // this, MAX() over nothing anchors the spec at epoch 0 and every create
    // fails with a confusing out-of-range message instead.
    expect(lastBusyEndMs).toBeGreaterThan(Date.now());
    freeSlotUtc = (days: number) => new Date(lastBusyEndMs + days * 86_400_000).toISOString();
    await createWebhook(db, {
      accountId: account!.id,
      subscriberUrl: 'https://example.com/hook',
      eventTriggers: ['booking.created'],
      key: WEBHOOK_KEY,
    });
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    svc = new AdminService(db, calendar, email);
  });

  const outboxRows = (kind: string) =>
    db.all<{ action: string; booking_uid: string | null }>(
      sql`SELECT action, booking_uid FROM outbox WHERE kind = ${kind}`,
    );

  // The side-effects are fire-and-forget (`void promise`) by design — poll
  // until the expected rows land instead of racing them.
  const waitFor = async (predicate: () => Promise<boolean>, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  };

  // One atomic read of the WHOLE outbox — counting per-kind takes two queries,
  // and a row landing between them yields a torn intermediate count. Every kind
  // counts here: "the rejected create enqueued nothing" should mean nothing.
  const outboxCount = async () =>
    Number((await db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM outbox`))!.n);

  // "Every enqueue has landed" is not a duration — it is the total no longer
  // moving. Sleeping a fixed 200ms and hoping raced the same way #159 did: on
  // a loaded runner a straggler from one create lands inside the window meant
  // to observe the next. Poll until the count holds still for `quietMs`, and
  // never settle below `min` (at t=0 nothing has landed yet and zero is quiet).
  const settledOutboxCount = async (min = 1, quietMs = 150, ms = 3000) => {
    const deadline = Date.now() + ms;
    let last = -1;
    let unchangedSince = Date.now();
    for (;;) {
      const n = await outboxCount();
      if (n !== last) {
        last = n;
        unchangedSince = Date.now();
      } else if (n >= min && Date.now() - unchangedSince >= quietMs) {
        return n;
      }
      if (Date.now() > deadline) return n;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('enqueues the booking.created webhook and the attendee email', async () => {
    const out = await svc.hostCreate(
      p,
      {
        slug,
        startUtc: freeSlotUtc(1),
        attendee: { name: 'QA Bot', email: 'qa@test.local', timeZone: 'UTC' },
        answers,
      },
      'acme',
    );
    if (!out.ok) throw new Error(`create failed: ${JSON.stringify(out)}`);

    expect(
      await waitFor(async () =>
        (await outboxRows('webhook')).some((r) => r.action === 'booking.created'),
      ),
    ).toBe(true);

    // Accepted → confirmation (+ scheduled reminders); pending → request-received.
    const expected = out.booking.status === 'accepted' ? 'confirmation' : 'pending';
    expect(
      await waitFor(async () =>
        (await outboxRows('email')).some(
          (r) => r.action === expected && r.booking_uid === out.booking.uid,
        ),
      ),
    ).toBe(true);
  });

  it('enqueues nothing when the create fails (same slot twice → SLOT_TAKEN)', async () => {
    const body = {
      slug,
      startUtc: freeSlotUtc(2),
      attendee: { name: 'QA Bot', email: 'qa@test.local', timeZone: 'UTC' },
      answers,
    };
    const first = await svc.hostCreate(p, body, 'acme');
    expect(first.ok).toBe(true);
    // Baseline: everything the FIRST create enqueues, once the total holds still.
    const afterFirst = await settledOutboxCount();
    expect(afterFirst).toBeGreaterThan(0);

    const second = await svc.hostCreate(p, body, 'acme');
    // Pin the REASON, not just the failure: were this to start failing as
    // INVALID, the "enqueues nothing" assertion below would pass vacuously.
    if (second.ok) throw new Error('expected the second create to be rejected');
    expect(second.reason).toBe('SLOT_TAKEN');
    // The rejected create must add nothing — same quiet-period observation.
    const afterSecond = await settledOutboxCount(afterFirst);
    expect(afterSecond).toBe(afterFirst);
  });
});
