import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, createWebhook, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { AdminService } from './admin.service';
import type { HostPrincipal } from './auth.service';

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
    await createWebhook(db, {
      accountId: account!.id,
      subscriberUrl: 'https://example.com/hook',
      eventTriggers: ['booking.created'],
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

  it('enqueues the booking.created webhook and the attendee email', async () => {
    const out = await svc.hostCreate(
      p,
      {
        slug,
        startUtc: new Date(Date.now() + 3 * 86_400_000).toISOString(),
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
      startUtc: new Date(Date.now() + 4 * 86_400_000).toISOString(),
      attendee: { name: 'QA Bot', email: 'qa@test.local', timeZone: 'UTC' },
      answers,
    };
    const first = await svc.hostCreate(p, body, 'acme');
    expect(first.ok).toBe(true);
    // Let ALL the fire-and-forget enqueues from the FIRST create settle.
    await waitFor(async () => (await outboxRows('webhook')).length > 0);
    await new Promise((r) => setTimeout(r, 200));
    const afterFirst = (await outboxRows('webhook')).length + (await outboxRows('email')).length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await svc.hostCreate(p, body, 'acme');
    expect(second.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    const afterSecond = (await outboxRows('webhook')).length + (await outboxRows('email')).length;
    expect(afterSecond).toBe(afterFirst);
  });
});
