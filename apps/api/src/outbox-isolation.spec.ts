import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  backoffMs,
  claimDueOutbox,
  createBooking,
  createDb,
  getAvailability,
  createWebhook,
  enqueueOutbox,
  listOutbox,
  listWebhookDeliveries,
  loadEncryptionKey,
  migrate,
  seed,
  sql,
  type Db,
} from '@slate/db';
import { DisabledCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { BookingNotifier, type EmailProvider, type EmailResult } from '@slate/notifications';
import { CalendarEffects } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { OutboxWorker } from './outbox.worker';
import { CalendarHttpError } from './calendar.http-provider';

// F7: one slow or failing destination must delay nothing but itself. Measured
// before this: a subscriber that slept 15 s held the single drain for its 10 s
// timeout on every attempt, retries came every 11 s instead of 1/2/4/8 s, every
// email and calendar write queued behind it, and the event was given up after
// about 45 s. These pin the opposite of each of those.

const KEY_B64 = randomBytes(32).toString('base64');
const KEY = loadEncryptionKey(KEY_B64);

function envWith(extra: Record<string, string> = {}): ServerEnv {
  return loadServerEnv({
    NODE_ENV: 'test',
    INTEGRATION_ENCRYPTION_KEY: KEY_B64,
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** A promise and the hands that settle it. */
function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

const sentEmails: string[] = [];
const recordingEmail: EmailProvider = {
  send(): Promise<EmailResult> {
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  },
};

function notification(accountId: string, uid: string) {
  return JSON.stringify({
    accountId,
    uid,
    title: 'Intro',
    startUtc: '2026-08-01T15:00:00.000Z',
    endUtc: '2026-08-01T15:30:00.000Z',
    host: { name: 'Alex', email: 'alex@example.com' },
    attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
  });
}

describe('OutboxWorker: isolation, backoff, horizon, leases (F7)', () => {
  let db: Db;
  let accountId: string;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  function makeWorker(env: ServerEnv = envWith(), calendar: CalendarProvider = new DisabledCalendarProvider()) {
    const email = new EmailEffects(new BookingNotifier(recordingEmail), db);
    const deliver = email.deliver.bind(email);
    email.deliver = async (kind, payload, ...rest) => {
      sentEmails.push((JSON.parse(payload) as { uid: string }).uid);
      return deliver(kind, payload, ...rest);
    };
    const worker = new OutboxWorker(db, env, new CalendarEffects(calendar, db), email, new DaptaSyncEffects(env));
    // The plain schedule, exactly: the jitter has its own spec in @slate/db.
    worker.random = () => 1;
    return worker;
  }

  async function webhook(url: string) {
    return createWebhook(db, { accountId, subscriberUrl: url, eventTriggers: ['booking.created'], key: KEY });
  }

  async function enqueueWebhook(webhookId: string, now = 0, uid = 'x') {
    return enqueueOutbox(db, {
      kind: 'webhook',
      action: 'booking.created',
      accountId,
      webhookId,
      payload: JSON.stringify({ event: 'booking.created', data: { uid } }),
      now,
    });
  }

  async function status(id: string) {
    return (await listOutbox(db)).find((r) => r.id === id)!;
  }

  beforeEach(async () => {
    sentEmails.length = 0;
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('a subscriber that hangs does not delay an email, and the next tick still drains other lanes', async () => {
    const worker = makeWorker();
    const slow = await webhook('https://198.51.100.10/slow');
    const hang = gate<Response>();
    let slowCalls = 0;
    worker.fetchImpl = (async () => {
      slowCalls++;
      return hang.promise;
    }) as unknown as typeof fetch;
    worker.now = () => 0;

    const hook = await enqueueWebhook(slow.id);
    const mail = await enqueueOutbox(db, {
      kind: 'email',
      action: 'confirmation',
      bookingUid: 'bk-1',
      accountId,
      payload: notification(accountId, 'bk-1'),
      now: 0,
    });

    await worker.pump();
    await until(async () => (await status(mail)).status === 'done');
    expect(slowCalls).toBe(1);
    expect((await status(hook)).status).toBe('pending');

    // A second email arriving while the subscriber still hangs goes out too.
    const mail2 = await enqueueOutbox(db, {
      kind: 'email',
      action: 'confirmation',
      bookingUid: 'bk-2',
      accountId,
      payload: notification(accountId, 'bk-2'),
      now: 0,
    });
    await worker.pump();
    await until(async () => (await status(mail2)).status === 'done');
    expect((await status(hook)).status).toBe('pending');

    hang.resolve({ ok: true, status: 200 } as Response);
    await until(async () => (await status(hook)).status === 'done');
    expect(sentEmails.sort()).toEqual(['bk-1', 'bk-2']);
  });

  it('a calendar write that hangs does not delay an email', async () => {
    const hang = gate<never>();
    const calendar: CalendarProvider = {
      ...new DisabledCalendarProvider(),
      enabled: true,
      listBusy: () => Promise.resolve([]),
      createEvent: () => hang.promise,
      updateEvent: () => hang.promise,
      deleteEvent: () => hang.promise,
      listCalendars: () => Promise.resolve([]),
      checkConnection: () => Promise.resolve({ ok: true, detail: 'ok' }),
    };
    const worker = makeWorker(envWith(), calendar);
    worker.now = () => 0;
    // A real booking with a destination calendar, so the job reaches createEvent.
    const member = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    await db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES ('cc-1', ${accountId}, ${member}, 'generic', 'ref-1', 1, 1, 0)`,
    );
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: Date.parse(avail!.slots[0]!.startUtc),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Acme' },
    });
    if (!booked.ok) throw new Error('seed booking failed');
    const uid = booked.booking.uid;
    const job = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid, now: 0 });
    const mail = await enqueueOutbox(db, {
      kind: 'email',
      action: 'confirmation',
      bookingUid: 'bk-9',
      accountId,
      payload: notification(accountId, 'bk-9'),
      now: 0,
    });
    await worker.pump();
    await until(async () => (await status(mail)).status === 'done');
    expect((await status(job)).status).toBe('pending');
  });

  it("one subscriber's backlog takes one slot: another subscriber is delivered while it hangs", async () => {
    const worker = makeWorker();
    const slow = await webhook('https://198.51.100.10/slow');
    const fast = await webhook('https://198.51.100.11/fast');
    const hang = gate<Response>();
    const calls: string[] = [];
    worker.fetchImpl = (async (url: string) => {
      calls.push(url);
      return url.includes('/slow') ? hang.promise : ({ ok: true, status: 200 } as Response);
    }) as unknown as typeof fetch;
    worker.now = () => 1000;

    // Five deliveries queued for the slow one BEFORE the fast one's.
    for (let i = 0; i < 5; i++) await enqueueWebhook(slow.id, i, `s${i}`);
    const fastRow = await enqueueWebhook(fast.id, 10, 'f');

    await worker.pump();
    await until(async () => (await status(fastRow)).status === 'done');
    // The slow subscriber has exactly one delivery in flight, not every slot.
    expect(calls.filter((u) => u.includes('/slow'))).toHaveLength(1);

    // Released, the backlog drains back to back, without waiting for a poll.
    hang.resolve({ ok: true, status: 200 } as Response);
    await until(async () => (await listOutbox(db, { status: 'done' })).length === 6);
  });

  it('backs off 1/2/4/8 s per entry, counted from each failure', async () => {
    const worker = makeWorker();
    const hook = await webhook('https://198.51.100.10/down');
    worker.fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const id = await enqueueWebhook(hook.id);

    const due: number[] = [];
    let at = 0;
    for (let i = 0; i < 5; i++) {
      await worker.drainOnce(at);
      at = (await status(id)).nextAttemptAt;
      due.push(at);
    }
    expect(due).toEqual([1000, 3000, 7000, 15_000, 31_000]);
    // ...and never past the cap, however long it fails.
    expect(backoffMs(30)).toBe(15 * 60_000);
  });

  it('a slow failure is rescheduled from when it failed, not from when its batch started', async () => {
    const worker = makeWorker();
    const hook = await webhook('https://198.51.100.10/slow-fail');
    const hang = gate<Response>();
    worker.fetchImpl = (async () => hang.promise) as unknown as typeof fetch;
    let clock = 0;
    worker.now = () => clock;
    const id = await enqueueWebhook(hook.id);
    await worker.pump();
    // The subscriber takes 12 s and then fails.
    clock = 12_000;
    hang.reject(new Error('timeout'));
    await until(async () => (await status(id)).attempts === 1);
    expect((await status(id)).nextAttemptAt).toBe(12_000 + 1000);
  });

  it('a subscriber down for a minute loses nothing: retries continue past the attempt budget', async () => {
    const worker = makeWorker(envWith({ OUTBOX_RETRY_HORIZON_MS: String(3_600_000) }));
    const hook = await webhook('https://198.51.100.10/flaky');
    let up = false;
    worker.fetchImpl = (async () => {
      if (!up) throw new Error('connect ECONNREFUSED');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const id = await enqueueWebhook(hook.id);

    let at = 0;
    while (at < 60_000) {
      await worker.drainOnce(at);
      at = (await status(id)).nextAttemptAt;
    }
    // Six failures in the first minute: the old worker had given up at five.
    const row = await status(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBeGreaterThan(row.maxAttempts);
    up = true;
    await worker.drainOnce(at);
    expect((await status(id)).status).toBe('done');
  });

  it('gives up only past the horizon: failed, logged, and named in the delivery log', async () => {
    const worker = makeWorker(envWith({ OUTBOX_RETRY_HORIZON_MS: String(3_600_000) }));
    const hook = await webhook('https://198.51.100.10/gone');
    worker.fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const id = await enqueueWebhook(hook.id);

    let at = 0;
    for (let i = 0; i < 5; i++) {
      await worker.drainOnce(at);
      at = (await status(id)).nextAttemptAt;
    }
    // Budget spent, horizon not: still trying.
    expect((await status(id)).status).toBe('pending');
    expect((await status(id)).firstFailedAt).toBe(0);
    expect(error).not.toHaveBeenCalled();

    await worker.drainOnce(3_600_000);
    const row = await status(id);
    expect(row.status).toBe('failed');
    expect(row.leaseToken).toBeNull();
    expect(error.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/failed for good after 6 attempts over 60m/);
    const log = await listWebhookDeliveries(db, accountId, hook.id, 1);
    expect(log[0]!.ok).toBe(false);
    expect(log[0]!.error).toMatch(/Gave up after 6 attempts/);
  });

  it('every attempt of one delivery carries the same delivery id, body and signature', async () => {
    const worker = makeWorker();
    const hook = await createWebhook(db, {
      accountId,
      subscriberUrl: 'https://198.51.100.10/idem',
      eventTriggers: ['booking.created'],
      secret: 's3cret',
      key: KEY,
    });
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    worker.fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ headers: init.headers, body: init.body });
      return { ok: seen.length >= 3, status: seen.length >= 3 ? 200 : 503 } as Response;
    }) as unknown as typeof fetch;
    const id = await enqueueWebhook(hook.id);
    await worker.drainOnce(0);
    await worker.drainOnce(1000);
    await worker.drainOnce(3000);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.headers['X-Slate-Delivery']))).toEqual(new Set([id]));
    expect(new Set(seen.map((s) => s.headers['X-Slate-Signature'])).size).toBe(1);
    expect(new Set(seen.map((s) => s.body)).size).toBe(1);
    expect((await status(id)).status).toBe('done');
  });

  it('two replicas draining one outbox deliver each row exactly once', async () => {
    const env = envWith();
    const a = makeWorker(env);
    const b = makeWorker(env);
    const uids = Array.from({ length: 12 }, (_, i) => `bk-${i}`);
    for (const uid of uids) {
      await enqueueOutbox(db, {
        kind: 'email',
        action: 'confirmation',
        bookingUid: uid,
        accountId,
        payload: notification(accountId, uid),
        now: 0,
      });
    }
    const [na, nb] = await Promise.all([a.drainOnce(0), b.drainOnce(0)]);
    expect(na + nb).toBe(12);
    expect([...sentEmails].sort()).toEqual([...uids].sort());
    expect((await listOutbox(db, { status: 'done' })).length).toBe(12);
  });

  it("a replica that died mid-delivery has its rows taken over once its lease runs out", async () => {
    const worker = makeWorker(envWith({ OUTBOX_LEASE_MS: '60000' }));
    await enqueueOutbox(db, {
      kind: 'email',
      action: 'confirmation',
      bookingUid: 'bk-dead',
      accountId,
      payload: notification(accountId, 'bk-dead'),
      now: 0,
    });
    // The dead replica claimed it and never came back.
    expect(await claimDueOutbox(db, 0, 10, { token: 'dead', leaseMs: 60_000 })).toHaveLength(1);
    expect(await worker.drainOnce(30_000)).toBe(0);
    expect(await worker.drainOnce(60_000)).toBe(1);
    expect(sentEmails).toEqual(['bk-dead']);
  });

  describe('a retry that waits hours must not undo what happened meanwhile', () => {
    /** A calendar backend that is down until told otherwise, and records what it was asked to write. */
    function backend() {
      const state = { down: true, created: 0, deleted: 0 };
      const provider: CalendarProvider = {
        enabled: true,
        listBusy: () => Promise.resolve([]),
        createEvent: async () => {
          if (state.down) throw new Error('backend 503');
          state.created++;
          return { externalEventId: `evt-${state.created}`, meetingUrl: null };
        },
        updateEvent: async (i) => ({ externalEventId: i.externalEventId, meetingUrl: null }),
        deleteEvent: async () => {
          if (state.down) throw new Error('backend 503');
          state.deleted++;
        },
        listCalendars: () => Promise.resolve([]),
        checkConnection: () => Promise.resolve({ ok: true, detail: 'ok' }),
      };
      return { state, provider };
    }

    async function booked(): Promise<string> {
      const member = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
      await db.run(
        sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
            VALUES ('cc-order', ${accountId}, ${member}, 'generic', 'ref-order', 1, 1, 0)`,
      );
      const avail = await getAvailability(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        fromMs: Date.now(),
        toMs: Date.now() + 10 * 86_400_000,
      });
      const b = await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startMs: Date.parse(avail!.slots[0]!.startUtc),
        attendee: { name: 'Sam', email: 'sam-order@example.com', timeZone: 'UTC' },
        answers: { company: 'Acme' },
      });
      if (!b.ok) throw new Error('seed booking failed');
      return b.booking.uid;
    }

    it('create fails, the visitor cancels, the backend recovers: no event is left on the calendar', async () => {
      const { state, provider } = backend();
      const worker = makeWorker(envWith(), provider);
      const uid = await booked();
      const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid, now: 0 });
      await worker.drainOnce(0); // the backend is down: the create backs off
      expect((await status(create)).attempts).toBe(1);

      await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid}`);
      const del = await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: uid, now: 10 });
      // The delete is due, but it never overtakes the create still backing off.
      await worker.drainOnce(20);
      expect((await status(del)).status).toBe('pending');
      expect((await status(del)).attempts).toBe(0);

      state.down = false;
      await worker.drainOnce(2_000);
      // The create sees the booking is off and is skipped; then the delete runs.
      expect((await status(create)).status).toBe('skipped');
      expect((await status(create)).lastError).toMatch(/the booking is cancelled/);
      expect((await status(del)).status).toBe('done');
      expect(state.created).toBe(0);
    });

    it('a confirmation still queued when the booking is cancelled is skipped, never sent after it', async () => {
      const worker = makeWorker();
      const uid = await booked();
      await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid}`);
      const mail = await enqueueOutbox(db, {
        kind: 'email',
        action: 'confirmation',
        bookingUid: uid,
        accountId,
        payload: notification(accountId, uid),
        now: 0,
      });
      await worker.drainOnce(0);
      expect((await status(mail)).status).toBe('skipped');
    });

    it('a reminder held back past the start of the meeting is dropped', async () => {
      const worker = makeWorker();
      const uid = await booked();
      await db.run(sql`UPDATE booking SET start_ms = ${Date.now() - 60_000} WHERE uid = ${uid}`);
      const mail = await enqueueOutbox(db, {
        kind: 'email',
        action: 'reminder',
        bookingUid: uid,
        accountId,
        payload: notification(accountId, uid),
        now: 0,
      });
      await worker.drainOnce(0);
      expect((await status(mail)).status).toBe('skipped');
      expect((await status(mail)).lastError).toMatch(/already started/);
    });

    it('a failure that names its wait (a backend Retry-After) is not asked again sooner', async () => {
      const failing: CalendarProvider = {
        ...backend().provider,
        createEvent: async () => {
          throw new CalendarHttpError(429, 'createEvent', 'slow down', 30_000);
        },
      };
      const worker = makeWorker(envWith(), failing);
      const uid = await booked();
      const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid, now: 0 });
      await worker.drainOnce(0);
      expect((await status(create)).nextAttemptAt).toBe(30_000);
    });
  });
});
