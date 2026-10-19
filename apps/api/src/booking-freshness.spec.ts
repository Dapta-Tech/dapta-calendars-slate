import { describe, it, expect, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import type {
  BusyInterval,
  CalendarProvider,
  CalendarSummary,
  ConnectionHealth,
  CreatedEvent,
  ListBusyInput,
} from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AdminService } from './admin.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { isServiceError } from './http';
import { CALENDAR_RETRY_AFTER_SECONDS, CalendarRetryAfterInterceptor } from './retry-after';

// Booking safety (ADR 0009): the display cache may show a time the calendar no
// longer has free, or keep showing times while the calendar is failing. That is
// only safe because nothing that DECIDES reads through it. These pin, for every
// write a visitor or a host can make, that (a) a time the cache still offers
// but the calendar now has busy is refused, and (b) a calendar that fails makes
// the write refuse with a retryable error, even with a good read cached.

/** The hosts' calendar backend: busy per connection, and a switch to fail every read. */
class Backend implements CalendarProvider {
  readonly enabled = true;
  busy = new Map<string, BusyInterval[]>();
  failing = false;
  reads = 0;
  listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    this.reads++;
    if (this.failing) return Promise.reject(new Error('backend 503'));
    const out: BusyInterval[] = [];
    for (const ref of input.connectionRefs)
      for (const b of this.busy.get(ref) ?? []) if (b.endUtc > input.fromUtc && b.startUtc < input.toUtc) out.push(b);
    return Promise.resolve(out);
  }
  createEvent(): Promise<CreatedEvent> {
    return Promise.resolve({ externalEventId: 'evt' });
  }
  updateEvent(): Promise<CreatedEvent> {
    return Promise.resolve({ externalEventId: 'evt' });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

const busyAt = (startUtc: string): BusyInterval => ({
  startUtc,
  endUtc: new Date(Date.parse(startUtc) + 30 * 60_000).toISOString(),
});

describe('booking paths read the calendar fresh, never the display cache (ADR 0009)', () => {
  let db: Db;
  let backend: Backend;
  let booking: BookingService;
  let admin: AdminService;
  let principal: { accountId: string; memberId: string; role: 'owner' };
  const q = () => ({
    accountCode: 'acme',
    handle: 'alex-rivera',
    slug: 'intro-call',
    from: new Date().toISOString(),
    to: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  });
  const attendee = (tag: string) => ({ name: 'Sam', email: `sam-${tag}@example.com`, timeZone: 'UTC' });

  async function setup(env: ServerEnv) {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const members = await db.all<{ id: string; handle: string }>(
      sql`SELECT id, handle FROM member WHERE handle IN ('alex-rivera', 'jordan-lee')`,
    );
    for (const m of members) {
      await db.run(
        sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
            VALUES (${`cc-${m.handle}`}, ${accountId}, ${m.id}, 'generic', ${`ref-${m.handle}`}, 0, 1, 0)`,
      );
    }
    principal = { accountId, memberId: members.find((m) => m.handle === 'alex-rivera')!.id, role: 'owner' };
    backend = new Backend();
    const calendar = new CalendarEffects(backend, db, env);
    const email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    booking = new BookingService(db, env, calendar, email);
    admin = new AdminService(db, calendar, email, undefined, undefined, env);
  }

  /** Busy on BOTH hosts' calendars at `startUtc`. */
  const makeBusy = (startUtc: string) => {
    backend.busy.set('ref-alex-rivera', [busyAt(startUtc)]);
    backend.busy.set('ref-jordan-lee', [busyAt(startUtc)]);
  };

  describe('with the default cache (30 s)', () => {
    beforeEach(() => setup(loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)));

    it('a time the cache still offers but the calendar now has busy is refused at hold, booking and reschedule', async () => {
      const first = await booking.availability(q());
      const [moveMe, target] = [first!.slots[0]!.startUtc, first!.slots[4]!.startUtc];
      const made = await booking.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: moveMe,
        attendee: attendee('move'),
        answers: { company: 'Acme' },
      });
      if (isServiceError(made)) throw new Error(made.message);
      const token = new URL(made.manageUrl!).searchParams.get('token')!;

      // Warm the display cache, then put an event on the calendar at `target`.
      await booking.availability(q());
      makeBusy(target);
      const shown = await booking.availability(q());
      // The cache is really in play: the page still shows the time...
      expect(shown!.slots.map((s) => s.startUtc)).toContain(target);

      // ...and every write refuses it, because each one read the calendar fresh.
      const hold = await booking.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc: target });
      expect(hold).toMatchObject({ error: 'INVALID_SLOT', status: 400 });
      const book = await booking.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: target,
        attendee: attendee('busy'),
        answers: { company: 'Acme' },
      });
      expect(book).toMatchObject({ error: 'SLOT_TAKEN', status: 409 });
      const moved = await booking.reschedule(made.uid, { newStartUtc: target, token });
      expect(moved).toMatchObject({ error: 'SLOT_TAKEN', status: 409 });
      const team = await booking.teamBook('acme', 'sales', {
        slug: 'team-demo',
        startUtc: target,
        attendee: attendee('team'),
      });
      expect(team).toMatchObject({ error: 'SLOT_TAKEN', status: 409 });
    });

    it("a host's confirmation reads the calendar fresh: busy refuses it, free confirms it", async () => {
      await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
      const slots = (await booking.availability(q()))!.slots;
      const request = async (startUtc: string, tag: string) => {
        const r = await booking.book({
          accountCode: 'acme',
          handle: 'alex-rivera',
          slug: 'intro-call',
          startUtc,
          attendee: attendee(tag),
          answers: { company: 'Acme' },
        });
        if (isServiceError(r)) throw new Error(r.message);
        expect(r.status).toBe('pending');
        return r.uid;
      };
      const busyOne = await request(slots[1]!.startUtc, 'a');
      const freeOne = await request(slots[6]!.startUtc, 'b');
      // The host's calendar filled the first request's time while it waited.
      backend.busy.set('ref-alex-rivera', [busyAt(slots[1]!.startUtc)]);
      const readsBefore = backend.reads;
      expect(await admin.confirm(principal, busyOne)).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
      expect(backend.reads).toBe(readsBefore + 1);
      expect(await admin.confirm(principal, freeOne)).toMatchObject({ ok: true });
    });
  });

  describe('with a calendar that fails, and a good read cached (stale-on-error)', () => {
    // A 1 ms TTL: every display read asks the calendar, so the failing read
    // below is answered by the stand-in, which is what is under test.
    beforeEach(() =>
      setup(loadServerEnv({ NODE_ENV: 'test', CALENDAR_BUSY_CACHE_TTL_MS: '1' } as NodeJS.ProcessEnv)),
    );

    it('the page keeps its times; every write refuses with a retryable CALENDAR_UNAVAILABLE', async () => {
      await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
      const slots = (await booking.availability(q()))!.slots;
      const pending = await booking.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: slots[2]!.startUtc,
        attendee: attendee('pending'),
        answers: { company: 'Acme' },
      });
      if (isServiceError(pending)) throw new Error(pending.message);
      await db.run(sql`UPDATE event_type SET requires_confirmation = 0 WHERE slug = 'intro-call'`);
      const accepted = await booking.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: slots[0]!.startUtc,
        attendee: attendee('accepted'),
        answers: { company: 'Acme' },
      });
      if (isServiceError(accepted)) throw new Error(accepted.message);
      const token = new URL(accepted.manageUrl!).searchParams.get('token')!;
      // Warm, after the writes above cleared this process's cached reads.
      await booking.availability(q());
      await new Promise((r) => setTimeout(r, 5));

      backend.failing = true;
      const target = slots[5]!.startUtc;
      // Display: the last good read stands in, so the page still has times.
      const shown = await booking.availability(q());
      expect(shown!.emptyReason).toBeUndefined();
      expect(shown!.slots.map((s) => s.startUtc)).toContain(target);

      const unavailable = { error: 'CALENDAR_UNAVAILABLE', status: 409 };
      expect(
        await booking.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc: target }),
      ).toMatchObject(unavailable);
      expect(
        await booking.book({
          accountCode: 'acme',
          handle: 'alex-rivera',
          slug: 'intro-call',
          startUtc: target,
          attendee: attendee('x'),
          answers: { company: 'Acme' },
        }),
      ).toMatchObject(unavailable);
      expect(await booking.reschedule(accepted.uid, { newStartUtc: target, token })).toMatchObject(unavailable);
      expect(
        await booking.teamBook('acme', 'sales', { slug: 'team-demo', startUtc: target, attendee: attendee('t') }),
      ).toMatchObject(unavailable);
      expect(await admin.confirm(principal, pending.uid)).toMatchObject({ ok: false, reason: 'CALENDAR_UNAVAILABLE' });
      // Nothing was written by any of them.
      expect(await db.all(sql`SELECT id FROM booking WHERE start_ms = ${Date.parse(target)}`)).toEqual([]);
      expect(await db.all(sql`SELECT id FROM slot_reservation`)).toEqual([]);
      const still = await db.get<{ status: string; start_ms: number }>(
        sql`SELECT status, start_ms FROM booking WHERE uid = ${pending.uid}`,
      );
      expect(still?.status).toBe('pending');
      const kept = await db.get<{ start_ms: number }>(sql`SELECT start_ms FROM booking WHERE uid = ${accepted.uid}`);
      expect(Number(kept?.start_ms)).toBe(Date.parse(slots[0]!.startUtc));
    });
  });
});

describe('CalendarRetryAfterInterceptor', () => {
  const run = async (body: unknown) => {
    const headers: Record<string, string> = {};
    const context = {
      switchToHttp: () => ({ getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }) }),
    } as never;
    const err = new HttpException(body as Record<string, unknown>, HttpStatus.CONFLICT);
    await expect(
      lastValueFrom(new CalendarRetryAfterInterceptor().intercept(context, { handle: () => throwError(() => err) })),
    ).rejects.toBe(err);
    return headers;
  };

  it('marks a write refused for an unreadable calendar as retryable, and nothing else', async () => {
    expect(await run({ error: 'CALENDAR_UNAVAILABLE', message: 'x' })).toEqual({
      'Retry-After': String(CALENDAR_RETRY_AFTER_SECONDS),
    });
    expect(await run({ error: 'SLOT_TAKEN', message: 'x' })).toEqual({});
  });
});
