import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, seed, sql, createEventType, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { PublicController } from './public.controller';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * #104 — an anonymous booker cannot set the idempotency key.
 *
 * `POST /v1/bookings` needs no credential, and the key it used to accept lands
 * in a column the whole deployment shares. The field is gone from
 * `createBookingSchema`, which drops unknown keys, so a body carrying it is
 * parsed as if it were not there. It reaches the service as caller-supplied
 * context now — the same channel `metadata` and `additionalAttendees` use, and
 * the same shape the team route was locked to in `a2fa755`.
 */
describe('#104 — the public booking payload cannot set an idempotency key', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;

  const service = () =>
    new BookingService(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendarProvider(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
  });

  async function slots(slug: string): Promise<string[]> {
    const svc = service();
    const r = await svc.availability({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      from: new Date().toISOString(),
      to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    return (r?.slots ?? []).map((s: { startUtc: string }) => s.startUtc);
  }

  it('ignores an idempotencyKey on the body and stores none', async () => {
    const slug = 'idem-public';
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
    });
    expect(ev.ok).toBe(true);
    const controller = new PublicController(service());
    const open = await slots(slug);

    const body = (startUtc: string, email: string) => ({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startUtc,
      attendee: { name: 'Pat', email, timeZone: 'America/New_York' },
      idempotencyKey: 'squatted-key',
    });

    const first = await controller.book(body(open[0]!, 'pat@example.com'));
    const second = await controller.book(body(open[1]!, 'sam@example.com'));

    // Two distinct bookings: the key was dropped, so the second request never
    // replayed the first — and nothing claimed the key in the shared column.
    expect(first).toMatchObject({ uid: expect.any(String) });
    expect(second).toMatchObject({ uid: expect.any(String) });
    expect((second as { uid: string }).uid).not.toBe((first as { uid: string }).uid);

    const stored = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key IS NOT NULL`,
    );
    expect(Number(stored!.n)).toBe(0);
  });

  it('still honours a key the service is handed as context', async () => {
    // The authenticated surfaces (the machine API's `Idempotency-Key` header,
    // the v2 compatibility service) pass it here, and retry dedupe must keep
    // working for them.
    const slug = 'idem-context';
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
    });
    expect(ev.ok).toBe(true);
    const svc = service();
    const open = await slots(slug);
    const payload = {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startUtc: open[0]!,
      attendee: { name: 'Pat', email: 'pat@example.com', timeZone: 'America/New_York' },
    };

    const first = await svc.book(payload, true, { apiKeyWrite: true, idempotencyKey: 'agent-retry-1' });
    const replay = await svc.book(payload, true, { apiKeyWrite: true, idempotencyKey: 'agent-retry-1' });
    expect(first).toMatchObject({ uid: expect.any(String) });
    expect(replay).toMatchObject({ uid: (first as { uid: string }).uid });

    const stored = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key IS NOT NULL`,
    );
    expect(Number(stored!.n)).toBe(1);
  });
});
