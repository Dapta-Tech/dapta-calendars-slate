import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  enqueueOutbox,
  getAvailability,
  tagCalendarChangeWithInviteeEmail,
  listOutbox,
  migrate,
  readCalendarChangeMark,
  seed,
  sql,
  type Db,
} from '@slate/db';
import type {
  CalendarProvider,
  CreateEventInput,
  CreatedEvent,
  DeleteEventInput,
  UpdateEventInput,
} from '@slate/calendar';
import {
  BookingNotifier,
  EmailRefusedError,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects, INVITEE_EMAIL_GRACE_MS } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { CONFERENCING_LINK_GRACE_MS, EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { OutboxWorker } from './outbox.worker';

/** A mail service that refuses the addresses it has suppressed, as the managed wire answers. */
class SuppressingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  readonly suppressed = new Set<string>();
  send(message: EmailMessage): Promise<EmailResult> {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    if (to.some((address) => this.suppressed.has(String(address).toLowerCase()))) {
      return Promise.reject(new EmailRefusedError('transactional email blocked by policy: recipient_suppressed'));
    }
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'http' });
  }
}

class RecordingCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  readonly created: CreateEventInput[] = [];
  readonly updated: UpdateEventInput[] = [];
  readonly deleted: DeleteEventInput[] = [];
  private seq = 0;
  listBusy(): Promise<[]> {
    return Promise.resolve([]);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    this.created.push(input);
    return Promise.resolve({ externalEventId: `evt-${++this.seq}`, meetingUrl: 'https://meet.example/room' });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    this.updated.push(input);
    return Promise.resolve({ externalEventId: input.externalEventId });
  }
  deleteEvent(input: DeleteEventInput): Promise<void> {
    this.deleted.push(input);
    return Promise.resolve();
  }
  listCalendars(): Promise<[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/**
 * One invitation per booking, and never none (F4 of the 2026-10-30 production
 * E2E). The host's event is written without the provider's own invitation
 * while dCal's email is on its way. When the mail service then refuses that
 * email (a suppressed recipient: 6 real confirmations in the 9 days before),
 * the provider invites the guest after all, and a cancellation it refused
 * leaves the provider's own cancellation in place.
 */
describe('a refused invitee email still leaves the guest one invitation', () => {
  let db: Db;
  let mail: SuppressingEmailProvider;
  let calendar: RecordingCalendarProvider;
  let booking: BookingService;
  let worker: OutboxWorker;
  let emailEffects: EmailEffects;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'google'}, ${'cal-dest-1'}, ${null}, ${1}, ${1}, ${Date.now()})`,
    );
    mail = new SuppressingEmailProvider();
    calendar = new RecordingCalendarProvider();
    const calendarEffects = new CalendarEffects(calendar, db);
    emailEffects = new EmailEffects(new BookingNotifier(mail), db, mail, ENV, calendar);
    booking = new BookingService(db, ENV, calendarEffects, emailEffects);
    worker = new OutboxWorker(db, ENV, calendarEffects, emailEffects, new DaptaSyncEffects(ENV));
  });

  async function book(email = 'sam@example.com'): Promise<string> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: a!.slots[0]!.startUtc,
      attendee: { name: 'Sam', email, timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    await settle();
    return out.uid;
  }

  const inviteeEmail = async (uid: string, action: string) =>
    (await listOutbox(db, { kind: 'email', bookingUid: uid })).find(
      (r) => r.action === action && JSON.parse(r.payload ?? '{}').audience === 'attendee',
    )!;

  it('a refused confirmation: recorded once, and the provider invites the guest on the same event', async () => {
    mail.suppressed.add('sam@example.com');
    const uid = await book();
    const t0 = Date.now();
    // The create runs first (the online meeting's email waits for its room) and,
    // with the confirmation still on its way, writes quietly.
    await worker.drainOnce(t0 + INVITEE_EMAIL_GRACE_MS + 1_000);
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0]!.sendInvitations).toBe(false);

    // The confirmation goes out and is refused: skipped at once, with the reason,
    // and the reinvite queued behind it runs in the same drain.
    await worker.drainOnce(t0 + CONFERENCING_LINK_GRACE_MS + 5_000);
    const confirmation = await inviteeEmail(uid, 'confirmation');
    expect(confirmation.status).toBe('skipped');
    expect(confirmation.attempts).toBe(0);
    expect(confirmation.lastError).toMatch(/blocked by policy: recipient_suppressed/);
    expect(calendar.updated).toHaveLength(2);
    expect(calendar.updated[0]!.attendeeEmails).not.toContain('sam@example.com');
    expect(calendar.updated[0]!.sendInvitations).toBe(false);
    expect(calendar.updated[1]!.attendeeEmails).toContain('sam@example.com');
    expect(calendar.updated[1]!.sendInvitations).toBe(true);
    const change = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.action === 'create')!;
    expect(readCalendarChangeMark(change.payload)).toMatchObject({ providerMuted: true, reinvited: true });
    // The host's own copy was not refused.
    expect(mail.sent.some((m) => String(m.to).includes('alex@example.com'))).toBe(true);

    // Nothing more later.
    await worker.drainOnce(t0 + 120_000);
    expect(calendar.updated).toHaveLength(2);
    expect((await listOutbox(db, { kind: 'calendar', bookingUid: uid })).every((r) => r.status === 'done')).toBe(true);
  });

  it('a confirmation that goes out leaves the event quiet, and nothing is re-sent', async () => {
    const uid = await book();
    const t0 = Date.now();
    await worker.drainOnce(t0 + INVITEE_EMAIL_GRACE_MS + 1_000);
    await worker.drainOnce(t0 + CONFERENCING_LINK_GRACE_MS + 5_000);
    expect((await inviteeEmail(uid, 'confirmation')).status).toBe('done');
    expect(calendar.created[0]!.sendInvitations).toBe(false);
    expect(calendar.updated).toHaveLength(0);
    expect((await listOutbox(db, { kind: 'calendar', bookingUid: uid })).map((r) => r.action)).toEqual(['create']);
  });

  it("only the invitee's confirmation or reschedule that marked a change queues a reinvite", async () => {
    const uid = await book();
    const reinvites = async () =>
      (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).filter((r) => r.action === 'reinvite').length;
    const gaveUp = (id: string, action: string, audience: string) =>
      emailEffects.afterGaveUp({ id, action, bookingUid: uid, payload: JSON.stringify({ audience }) });
    const confirmation = await inviteeEmail(uid, 'confirmation');
    // Not the invitee's, not a change that writes an invitation, or a mark on no change: nothing.
    await gaveUp(confirmation.id, 'confirmation', 'host');
    await gaveUp(confirmation.id, 'reminder', 'attendee');
    await gaveUp(confirmation.id, 'cancellation', 'attendee');
    await gaveUp('unmarked-email', 'confirmation', 'attendee');
    expect(await reinvites()).toBe(0);
    // The confirmation that marked the booking's create: one reinvite.
    await gaveUp(confirmation.id, 'confirmation', 'attendee');
    expect(await reinvites()).toBe(1);
    // A reschedule email on a booking that is off by now: nothing.
    const moveEmail = await enqueueOutbox(db, { kind: 'email', action: 'reschedule', bookingUid: uid });
    await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: uid });
    await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'reschedule', emailOutboxId: moveEmail });
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid}`);
    await gaveUp(moveEmail, 'reschedule', 'attendee');
    expect(await reinvites()).toBe(1);
  });

  it('a refused cancellation: the provider sends its own; an accepted one keeps the delete quiet', async () => {
    for (const refused of [true, false]) {
      const address = refused ? 'refused@example.com' : 'fine@example.com';
      if (refused) mail.suppressed.add(address);
      const uid = await book(address);
      const t0 = Date.now();
      await worker.drainOnce(t0 + CONFERENCING_LINK_GRACE_MS + 5_000);
      const deletedBefore = calendar.deleted.length;
      const out = await booking.cancel(uid, { byHost: true });
      expect(out).not.toHaveProperty('error');
      await settle();
      const t1 = Date.now();
      // Whichever runs first, the delete decides only once the cancellation's fate is known.
      for (let step = 1; step <= 6; step++) await worker.drainOnce(t1 + INVITEE_EMAIL_GRACE_MS + step * 4_000);
      expect((await inviteeEmail(uid, 'cancellation')).status, address).toBe(refused ? 'skipped' : 'done');
      expect(calendar.deleted.length, address).toBe(deletedBefore + 1);
      expect(calendar.deleted.at(-1)!.sendInvitations, address).toBe(refused);
    }
  });
});
