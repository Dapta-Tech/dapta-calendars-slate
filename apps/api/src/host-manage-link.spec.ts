import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, getAvailability, listOutbox, migrate, seed, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, NoopEmailProvider, type EmailMessage, type EmailProvider } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/**
 * The manage link in a booking email is the INVITEE's tokenised link: it
 * reschedules or cancels their booking. The host's copy of a confirmation, a
 * reschedule, a request or a reminder used to carry it too, as Reschedule and
 * Cancel buttons, so one click in the host's inbox acted on the invitee's
 * booking as the invitee. The host side is never handed the link at enqueue,
 * and a host row queued before this change still renders without it.
 */
const MANAGE = 'https://app.example.test/manage/bk-1?token=invitee-secret';

describe("the invitee's manage link never reaches the host's copy", () => {
  let db: Db;
  let email: EmailEffects;
  let booking: BookingService;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    email = new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db);
    booking = new BookingService(db, ENV, new CalendarEffects(new DisabledCalendarProvider(), db), email);
  });

  /** A real booking through the public path, which queues the confirmation and the reminders. */
  async function book(): Promise<string> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now() + 2 * 86_400_000,
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: a!.slots[0]!.startUtc,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return out.uid;
  }

  it('is dropped from every host row at enqueue, and kept on the invitee rows', async () => {
    const uid = await book();
    await email.enqueuePending(uid, { manageUrl: MANAGE });
    await email.enqueueReschedule(uid, { manageUrl: MANAGE, previousStartUtc: '2026-08-02T15:00:00.000Z' });

    const rows = (await listOutbox(db, { kind: 'email', bookingUid: uid })).map((r) => ({
      action: r.action,
      ...(JSON.parse(r.payload!) as { audience?: string; manageUrl?: string | null }),
    }));
    const host = rows.filter((r) => r.audience === 'host');
    const invitee = rows.filter((r) => r.audience === 'attendee');
    // Every kind that hands the invitee the link has a host copy too.
    for (const action of ['confirmation', 'pending', 'reschedule', 'reminder']) {
      expect(host.some((r) => r.action === action), action).toBe(true);
      expect(invitee.find((r) => r.action === action)?.manageUrl, action).toMatch(/^https?:\/\//);
    }
    for (const r of host) expect(r.manageUrl ?? null, r.action).toBeNull();
    const links = new Set(invitee.map((r) => r.manageUrl));
    for (const r of host) for (const link of links) expect(JSON.stringify(r), r.action).not.toContain(link!);
  });

  it('a host row queued before the change, still holding the link, sends without it', async () => {
    const sent: EmailMessage[] = [];
    const recorder: EmailProvider = {
      send: (m) => {
        sent.push(m);
        return Promise.resolve({ delivered: true, driver: 'smtp' });
      },
    };
    const email = new EmailEffects(new BookingNotifier(recorder), db);
    for (const kind of ['confirmation', 'pending', 'reschedule', 'reminder', 'cancellation', 'declined']) {
      await email.deliver(
        kind,
        JSON.stringify({
          accountId: 'acct-1',
          title: 'Intro call',
          startUtc: '2026-10-20T15:00:00.000Z',
          endUtc: '2026-10-20T15:30:00.000Z',
          host: { name: 'Alex Rivera', email: 'host@example.test' },
          attendee: { name: 'Sam Guest', email: 'guest@example.test', timeZone: 'UTC' },
          audience: 'host',
          manageUrl: MANAGE,
        }),
      );
      const m = sent.at(-1)!;
      expect(`${m.html}\n${m.text}`, kind).not.toContain('invitee-secret');
    }
  });
});
