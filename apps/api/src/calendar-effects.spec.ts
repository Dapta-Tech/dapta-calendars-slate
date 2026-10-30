import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  migrate,
  seed,
  sql,
  createBooking,
  getAvailability,
  enqueueOutbox,
  DEFAULT_MAX_ATTEMPTS,
  listOutbox,
  markOutboxDone,
  readCalendarChangeMark,
  tagCalendarChangeWithInviteeEmail,
  type Db,
} from '@slate/db';
import type {
  CalendarProvider,
  CalendarSummary,
  ConnectionHealth,
  CreateEventInput,
  CreatedEvent,
  DeleteEventInput,
  UpdateEventInput,
} from '@slate/calendar';
import { LEGACY_CONFERENCING_VALUE } from '@slate/engine';
import { getMessages } from '@slate/shared';
import {
  CalendarEffects,
  INVITEE_EMAIL_GRACE_MS,
  INVITEE_EMAIL_MAX_LOOKS,
  INVITEE_EMAIL_RETRY_MS,
  INVITEE_EMAIL_WAIT_ATTEMPTS,
  InviteeEmailPendingError,
  eventBody,
} from './calendar-effects';
import { OutboxSkipError } from './email-effects';

/** A fake provider that records writes, moves AND deletes (the port's effects). */
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
    return Promise.resolve({ externalEventId: `evt-${++this.seq}`, meetingUrl: 'https://meet/x' });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    this.updated.push(input);
    return Promise.resolve({ externalEventId: input.externalEventId, meetingUrl: 'https://meet/x' });
  }
  deleteEvent(input: DeleteEventInput): Promise<void> {
    this.deleted.push(input);
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

/**
 * A calendar that notifies guests the way Google does (checked 2026-10-30):
 * with notifications on, a guest gets an email when the event is created with
 * them, when they are added to it, when its time changes, and when it is
 * deleted; saving it with nothing changed sends nothing. `notices` lists every
 * email the provider sent to a guest. `fail` makes one call throw.
 */
class NotifyingCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  readonly notices: Array<{ to: string; kind: 'invite' | 'update' | 'cancel'; ref: string }> = [];
  readonly updated: UpdateEventInput[] = [];
  readonly created: CreateEventInput[] = [];
  private readonly events = new Map<string, { start: string; end: string; attendees: string[]; ref: string }>();
  private seq = 0;
  fail: ((op: 'create' | 'update', ref: string) => boolean) | null = null;
  constructor(private readonly guests: string[]) {}
  private tell(to: string[], kind: 'invite' | 'update' | 'cancel', ref: string): void {
    for (const a of to) if (this.guests.includes(a)) this.notices.push({ to: a, kind, ref });
  }
  listBusy(): Promise<[]> {
    return Promise.resolve([]);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    if (this.fail?.('create', input.connectionRef)) return Promise.reject(new Error('vendor 503'));
    this.created.push(input);
    const id = `evt-${++this.seq}`;
    this.events.set(id, { start: input.startUtc, end: input.endUtc, attendees: [...input.attendeeEmails], ref: input.connectionRef });
    if (input.sendInvitations !== false) this.tell(input.attendeeEmails, 'invite', input.connectionRef);
    return Promise.resolve({ externalEventId: id, meetingUrl: 'https://meet/x' });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    if (this.fail?.('update', input.connectionRef)) return Promise.reject(new Error('vendor 503'));
    this.updated.push(input);
    const before = this.events.get(input.externalEventId)!;
    const moved = before.start !== input.startUtc || before.end !== input.endUtc;
    if (input.sendInvitations !== false) {
      this.tell(input.attendeeEmails.filter((a) => !before.attendees.includes(a)), 'invite', input.connectionRef);
      if (moved) this.tell(input.attendeeEmails.filter((a) => before.attendees.includes(a)), 'update', input.connectionRef);
    }
    this.events.set(input.externalEventId, { ...before, start: input.startUtc, end: input.endUtc, attendees: [...input.attendeeEmails] });
    return Promise.resolve({ externalEventId: input.externalEventId });
  }
  deleteEvent(input: DeleteEventInput): Promise<void> {
    const before = this.events.get(input.externalEventId);
    if (before && input.sendInvitations !== false) this.tell(before.attendees, 'cancel', input.connectionRef);
    this.events.delete(input.externalEventId);
    return Promise.resolve();
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

// Awaitable views of the fire-and-forget effect methods (production callers do
// not await them; tests exercise the same private core deterministically).
type Job = { id: string; attempts: number };
type Awaitable = {
  writeEvent(uid: string, inviteeEmailId?: string, job?: Job): Promise<void>;
  removeEvent(uid: string, inviteeEmailId?: string, job?: Job): Promise<void>;
  moveEvent(uid: string, inviteeEmailId?: string, job?: Job): Promise<void>;
};

describe('CalendarEffects — booking lifecycle → CalendarProvider port (E4/B9/C14)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  const CAL_REF = 'cal-dest-1';

  async function bookFirstSlot(): Promise<string> {
    const fromMs = Date.now();
    const toMs = fromMs + 10 * 86_400_000;
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs,
      toMs,
    });
    const startMs = new Date(avail!.slots[0]!.startUtc).getTime();
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    if (!booked.ok) throw new Error('seed booking failed');
    return booked.booking.uid;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
    // A write-destination calendar for the host.
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email,
             is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'google'}, ${CAL_REF}, ${null},
             ${1}, ${1}, ${Date.now()})`,
    );
  });

  // F4 of the 2026-10-30 production E2E: the invitee got two invitations per
  // booking (this service's email with its .ics, and the provider's own) and
  // two cancellations. The provider now stays quiet whenever the invitee gets
  // this service's email for the change.
  describe('one invitation per booking (sendInvitations)', () => {
    // The invitee's email for a change, as EmailEffects queues it.
    const queueInviteeEmail = (uid: string, action: string) =>
      enqueueOutbox(db, { kind: 'email', action, bookingUid: uid, orderKey: `${uid}|attendee` });

    it('create, move and delete stay quiet when the change carries the invitee email queued for it', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const write = effects as unknown as Awaitable;
      await write.writeEvent(uid, await queueInviteeEmail(uid, 'confirmation'));
      await write.moveEvent(uid, await queueInviteeEmail(uid, 'reschedule'));
      // A delete stays quiet once the mail service has taken the cancellation.
      const cancellation = await queueInviteeEmail(uid, 'cancellation');
      await markOutboxDone(db, cancellation);
      await write.removeEvent(uid, cancellation);
      expect(provider.created[0]!.sendInvitations).toBe(false);
      expect(provider.updated[0]!.sendInvitations).toBe(false);
      expect(provider.deleted[0]!.sendInvitations).toBe(false);
    });

    /** A delete row marked with this cancellation email, run the way the worker runs it. */
    async function deleteJob(effects: CalendarEffects, uid: string, cancellation: string) {
      const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: uid });
      await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'delete', emailOutboxId: cancellation });
      let attempts = 0;
      return async () => {
        const row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!;
        return effects.runCalendarJob('delete', uid, row.payload, { id: rowId, attempts: attempts++ });
      };
    }

    it('a delete looks at its cancellation email a few times, then takes it back and lets the provider cancel', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      const cancellation = await queueInviteeEmail(uid, 'cancellation');
      const run = await deleteJob(effects, uid, cancellation);
      for (let look = 0; look < INVITEE_EMAIL_WAIT_ATTEMPTS; look++) {
        const wait = run();
        await expect(wait).rejects.toBeInstanceOf(InviteeEmailPendingError);
        await expect(wait).rejects.toMatchObject({ retryAfterMs: INVITEE_EMAIL_RETRY_MS });
      }
      expect(provider.deleted).toHaveLength(0);
      // Still not sent after the wait: ours is taken back, the provider cancels.
      await run();
      expect(provider.deleted[0]!.sendInvitations).toBe(true);
      const email = (await listOutbox(db, { kind: 'email', bookingUid: uid })).find((r) => r.id === cancellation)!;
      expect(email.status).toBe('skipped');
      expect(email.lastError).toMatch(/calendar sent its own cancellation/);
    });

    it('the looks are counted apart from failures, and an email being sent is waited for', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      const cancellation = await queueInviteeEmail(uid, 'cancellation');
      const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: uid });
      const mark = JSON.stringify({ inviteeEmailId: cancellation });
      // Many failed attempts before (a provider outage) leave the wait whole.
      await expect(effects.runCalendarJob('delete', uid, mark, { id: rowId, attempts: 7 })).rejects.toBeInstanceOf(
        InviteeEmailPendingError,
      );
      // Wait spent, but a worker is sending the email right now: still waiting.
      await db.run(sql`UPDATE outbox SET lease_until = ${Date.now() + 60_000}, lease_token = ${'w1'} WHERE id = ${cancellation}`);
      const spent = JSON.stringify({ inviteeEmailId: cancellation, emailWaits: INVITEE_EMAIL_WAIT_ATTEMPTS });
      await expect(effects.runCalendarJob('delete', uid, spent, { id: rowId, attempts: 8 })).rejects.toBeInstanceOf(
        InviteeEmailPendingError,
      );
      // That look is counted too, and the flags already on the mark are kept.
      const counted = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!;
      expect(readCalendarChangeMark(counted.payload)).toEqual({
        inviteeEmailId: cancellation,
        emailWaits: INVITEE_EMAIL_WAIT_ATTEMPTS + 1,
      });
      // It went out: the delete stays quiet.
      await markOutboxDone(db, cancellation);
      await effects.runCalendarJob('delete', uid, spent, { id: rowId, attempts: 9 });
      expect(provider.deleted[0]!.sendInvitations).toBe(false);
    });

    it('an email being sent for too long does not hold the delete: past the last look the provider cancels', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      const cancellation = await queueInviteeEmail(uid, 'cancellation');
      await db.run(sql`UPDATE outbox SET lease_until = ${Date.now() + 60_000}, lease_token = ${'w1'} WHERE id = ${cancellation}`);
      const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: uid });
      const last = JSON.stringify({ inviteeEmailId: cancellation, emailWaits: INVITEE_EMAIL_MAX_LOOKS, providerMuted: true });
      await effects.runCalendarJob('delete', uid, last, { id: rowId, attempts: 0 });
      expect(provider.deleted[0]!.sendInvitations).toBe(true);
    });

    it('a cancellation the mail service refused, or that was given up on, never mutes the delete', async () => {
      for (const status of ['skipped', 'failed']) {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        await (effects as unknown as Awaitable).writeEvent(uid);
        const cancellation = await queueInviteeEmail(uid, 'cancellation');
        await db.run(sql`UPDATE outbox SET status = ${status} WHERE id = ${cancellation}`);
        await (await deleteJob(effects, uid, cancellation))();
        expect(provider.deleted[0]!.sendInvitations, status).toBe(true);
      }
    });

    it('a delete row has room for the wait on top of its own attempts', async () => {
      const effects = new CalendarEffects(new RecordingCalendarProvider(), db);
      const uid = await bookFirstSlot();
      effects.onBookingCancelled(uid);
      let row;
      for (let i = 0; i < 50 && !row; i++) {
        await new Promise((r) => setTimeout(r, 5));
        row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.action === 'delete');
      }
      expect(row!.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS + INVITEE_EMAIL_MAX_LOOKS);
    });

    it('a quiet create records it on its own row; one that invites does not', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const emailId = await queueInviteeEmail(uid, 'confirmation');
      const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid });
      await effects.runCalendarJob('create', uid, JSON.stringify({ inviteeEmailId: emailId }), { id: rowId, attempts: 0 });
      expect(provider.created[0]!.sendInvitations).toBe(false);
      const row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!;
      expect(readCalendarChangeMark(row.payload)).toEqual({ inviteeEmailId: emailId, providerMuted: true });

      const other = await bookFirstSlot();
      const otherRow = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: other });
      await effects.runCalendarJob('create', other, null, { id: otherRow, attempts: 0 });
      expect((await listOutbox(db, { kind: 'calendar', bookingUid: other }))[0]!.payload).toBeNull();
    });

    describe('reinvite: the email a quiet change counted on never went out', () => {
      /** A booking whose create ran quietly on its confirmation email, which then ended `status`. */
      async function quietCreate(provider: RecordingCalendarProvider, status: 'skipped' | 'failed' = 'skipped') {
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        const emailId = await queueInviteeEmail(uid, 'confirmation');
        const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid });
        const mark = JSON.stringify({ inviteeEmailId: emailId });
        await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'create', emailOutboxId: emailId });
        await effects.runCalendarJob('create', uid, mark, { id: rowId, attempts: 0 });
        await markOutboxDone(db, rowId);
        await db.run(sql`UPDATE outbox SET status = ${status} WHERE id = ${emailId}`);
        return { effects, uid, emailId, rowId, reinvite: JSON.stringify({ inviteeEmailId: emailId }) };
      }

      it("takes the guest off the organizer's event quietly, then puts them back with the provider inviting", async () => {
        for (const status of ['skipped', 'failed'] as const) {
          const provider = new RecordingCalendarProvider();
          const { effects, uid, rowId, reinvite } = await quietCreate(provider, status);
          expect(provider.created[0]!.sendInvitations).toBe(false);
          await effects.runCalendarJob('reinvite', uid, reinvite, { id: 'reinvite-1', attempts: 0 });
          expect(provider.updated, status).toHaveLength(2);
          const [off, back] = provider.updated;
          // The event the create wrote (the fake numbers them from evt-1).
          expect(off!.externalEventId).toBe('evt-1');
          expect(back!.externalEventId).toBe('evt-1');
          expect(off!.attendeeEmails).toEqual(['alex@example.com']);
          expect(off!.sendInvitations).toBe(false);
          expect(back!.attendeeEmails).toEqual(['alex@example.com', 'sam@example.com']);
          expect(back!.sendInvitations).toBe(true);
          // Same event and room, body untouched.
          for (const call of [off!, back!]) {
            expect(call.requestConferenceLink).toBeUndefined();
            expect(call).not.toHaveProperty('description');
            expect(call.startUtc).toBe(provider.created[0]!.startUtc);
          }
          const row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!;
          expect(readCalendarChangeMark(row.payload)!.reinvited).toBe(true);
          // Once is enough: a second run of the same job sends nothing more.
          await effects.runCalendarJob('reinvite', uid, reinvite, { id: 'reinvite-1', attempts: 1 });
          expect(provider.updated).toHaveLength(2);
        }
      });

      it('a retry after the guest was taken off only puts them back', async () => {
        const provider = new RecordingCalendarProvider();
        const { effects, uid, rowId, reinvite } = await quietCreate(provider);
        const putBack = provider.updateEvent.bind(provider);
        let failNext = true;
        provider.updateEvent = (input) => {
          if (input.sendInvitations && failNext) {
            failNext = false;
            return Promise.reject(new Error('vendor 503'));
          }
          return putBack(input);
        };
        await expect(effects.runCalendarJob('reinvite', uid, reinvite, { id: 'r', attempts: 0 })).rejects.toThrow('vendor 503');
        const after = (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!;
        expect(readCalendarChangeMark(after.payload)).toMatchObject({ guestRemoved: true });
        await effects.runCalendarJob('reinvite', uid, reinvite, { id: 'r', attempts: 1 });
        // One quiet removal in all, and the guest put back once with the provider inviting.
        expect(provider.updated.filter((u) => u.sendInvitations === false)).toHaveLength(1);
        expect(provider.updated.filter((u) => u.sendInvitations === true)).toHaveLength(1);
      });

      it('a create retried after its email was refused invites from the event, and leaves no reinvite to do', async () => {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        const emailId = await queueInviteeEmail(uid, 'confirmation');
        const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid });
        await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'create', emailOutboxId: emailId });
        const create = provider.createEvent.bind(provider);
        provider.createEvent = () => Promise.reject(new Error('vendor 503'));
        const payload = async () => (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!.payload;
        await expect(effects.runCalendarJob('create', uid, await payload(), { id: rowId, attempts: 0 })).rejects.toThrow();
        expect(readCalendarChangeMark(await payload())!.providerMuted).toBe(true);
        provider.createEvent = create;
        await db.run(sql`UPDATE outbox SET status = 'skipped' WHERE id = ${emailId}`);
        await effects.runCalendarJob('create', uid, await payload(), { id: rowId, attempts: 1 });
        expect(provider.created[0]!.sendInvitations).toBe(true);
        expect(readCalendarChangeMark(await payload())!.providerMuted).toBeUndefined();
        await markOutboxDone(db, rowId);
        await effects.runCalendarJob('reinvite', uid, JSON.stringify({ inviteeEmailId: emailId }), { id: 'r', attempts: 0 });
        expect(provider.updated).toHaveLength(0);
      });

      it('nothing to do when the change invited with the provider itself', async () => {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        const emailId = await queueInviteeEmail(uid, 'confirmation');
        await db.run(sql`UPDATE outbox SET status = 'skipped' WHERE id = ${emailId}`);
        const rowId = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid });
        await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'create', emailOutboxId: emailId });
        await effects.runCalendarJob('create', uid, JSON.stringify({ inviteeEmailId: emailId }), { id: rowId, attempts: 0 });
        await markOutboxDone(db, rowId);
        expect(provider.created[0]!.sendInvitations).toBe(true);
        await effects.runCalendarJob('reinvite', uid, JSON.stringify({ inviteeEmailId: emailId }), { id: 'r', attempts: 0 });
        expect(provider.updated).toHaveLength(0);
      });

      it('waits while the change has not run yet, and is skipped once the booking is off', async () => {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        const emailId = await queueInviteeEmail(uid, 'confirmation');
        await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: uid });
        await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'create', emailOutboxId: emailId });
        const reinvite = JSON.stringify({ inviteeEmailId: emailId });
        await expect(effects.runCalendarJob('reinvite', uid, reinvite)).rejects.toBeInstanceOf(InviteeEmailPendingError);

        const cancelled = await quietCreate(provider);
        await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${cancelled.uid}`);
        await expect(effects.runCalendarJob('reinvite', cancelled.uid, cancelled.reinvite)).rejects.toBeInstanceOf(
          OutboxSkipError,
        );
        expect(provider.updated).toHaveLength(0);
      });

      it('a host who booked themselves has nobody to re-invite', async () => {
        const provider = new RecordingCalendarProvider();
        const { effects, uid, reinvite } = await quietCreate(provider);
        await db.run(
          sql`UPDATE booking_attendee SET email = ${'alex@example.com'}
              WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
        );
        await effects.runCalendarJob('reinvite', uid, reinvite, { id: 'r', attempts: 0 });
        expect(provider.updated).toHaveLength(0);
      });
    });

    it('a change no invitee email marked (switched off, no address, failed) keeps the provider inviting', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      // An email for ANOTHER change exists; this one carries none.
      await queueInviteeEmail(uid, 'reschedule');
      await (effects as unknown as Awaitable).writeEvent(uid);
      expect(provider.created[0]!.sendInvitations).toBe(true);
    });

    it('a marked email the transport gave up on, or that was dropped, keeps the provider inviting', async () => {
      for (const status of ['failed', 'skipped']) {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        const emailId = await queueInviteeEmail(uid, 'confirmation');
        await db.run(sql`UPDATE outbox SET status = ${status} WHERE id = ${emailId}`);
        await (effects as unknown as Awaitable).writeEvent(uid, emailId);
        expect(provider.created[0]!.sendInvitations, status).toBe(true);
      }
    });

    it('a mark naming no queued email keeps the provider inviting', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid, 'no-such-outbox-row');
      expect(provider.created[0]!.sendInvitations).toBe(true);
    });

    it('a move that falls back to a create keeps the reschedule email it carries', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      // Accepted, then moved before the create drained: no event to move yet.
      await (effects as unknown as Awaitable).moveEvent(uid, await queueInviteeEmail(uid, 'reschedule'));
      expect(provider.updated).toHaveLength(0);
      expect(provider.created[0]!.sendInvitations).toBe(false);
    });

    it('a mail transport that never delivers (log-only, noop) keeps the provider inviting', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db, undefined, { delivers: false });
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid, await queueInviteeEmail(uid, 'confirmation'));
      expect(provider.created[0]!.sendInvitations).toBe(true);
    });

    it('the worker hands the job the mark the email side put on its row', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      effects.onBookingAccepted(uid);
      let row;
      for (let i = 0; i < 50 && !row; i++) {
        await new Promise((r) => setTimeout(r, 5));
        row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid }))[0];
      }
      const emailId = await queueInviteeEmail(uid, 'confirmation');
      expect(await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action: 'create', emailOutboxId: emailId })).toBe(true);
      const marked = (await listOutbox(db, { kind: 'calendar', bookingUid: uid }))[0]!;
      expect(marked.id).toBe(row!.id);
      await effects.runCalendarJob('create', uid, marked.payload);
      expect(provider.created[0]!.sendInvitations).toBe(false);
    });

    it('a guest we never email (an extra attendee) keeps the provider inviting', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const emailId = await queueInviteeEmail(uid, 'confirmation');
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      await db.run(
        sql`INSERT INTO booking_guest (id, booking_id, email, email_normalized, name, created_at)
            VALUES (${randomUUID()}, ${bookingId}, ${'extra@example.com'}, ${'extra@example.com'}, ${null}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).writeEvent(uid, emailId);
      expect(provider.created[0]!.sendInvitations).toBe(true);
    });

    it("the organizer's own address among the attendees is not a guest to invite", async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const emailId = await queueInviteeEmail(uid, 'confirmation');
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      await db.run(
        sql`INSERT INTO booking_guest (id, booking_id, email, email_normalized, name, created_at)
            VALUES (${randomUUID()}, ${bookingId}, ${'Alex@Example.com'}, ${'alex@example.com'}, ${null}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).writeEvent(uid, emailId);
      expect(provider.created[0]!.sendInvitations).toBe(false);
    });

    it('a host who booked themselves plus another guest: that guest still gets the provider invite', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const confirmationId = await queueInviteeEmail(uid, 'confirmation');
      const rescheduleId = await queueInviteeEmail(uid, 'reschedule');
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      await db.run(sql`UPDATE booking_attendee SET email = ${'alex@example.com'} WHERE booking_id = ${bookingId}`);
      await (effects as unknown as Awaitable).writeEvent(uid, confirmationId);
      // Only the host: nobody to invite.
      expect(provider.created[0]!.sendInvitations).toBe(false);
      await db.run(
        sql`INSERT INTO booking_guest (id, booking_id, email, email_normalized, name, created_at)
            VALUES (${randomUUID()}, ${bookingId}, ${'extra@example.com'}, ${'extra@example.com'}, ${null}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).moveEvent(uid, rescheduleId);
      expect(provider.updated[0]!.sendInvitations).toBe(true);
    });

    it('the calendar row waits a moment for the invitee email the same request queues', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const before = Date.now();
      effects.onBookingAccepted(uid);
      let row;
      for (let i = 0; i < 50 && !row; i++) {
        await new Promise((r) => setTimeout(r, 5));
        row = (await listOutbox(db, { kind: 'calendar', bookingUid: uid }))[0];
      }
      expect(row!.nextAttemptAt).toBeGreaterThanOrEqual(before + INVITEE_EMAIL_GRACE_MS);
    });

    it('a booking with an address but no kind (written before kinds) is not an online meeting', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await db.run(sql`UPDATE booking SET location_kind = ${null}, location = ${'12 Main St'} WHERE uid = ${uid}`);
      await (effects as unknown as Awaitable).writeEvent(uid);
      expect(provider.created[0]!.requestConferenceLink).toBe(false);
    });

    it('an online meeting or no location asks for a room; in person never does', async () => {
      for (const [kind, wanted] of [
        ['conferencing', true],
        [null, true],
        ['in_person', false],
      ] as const) {
        const provider = new RecordingCalendarProvider();
        const effects = new CalendarEffects(provider, db);
        const uid = await bookFirstSlot();
        await db.run(sql`UPDATE booking SET location_kind = ${kind} WHERE uid = ${uid}`);
        await (effects as unknown as Awaitable).writeEvent(uid);
        expect(provider.created[0]!.requestConferenceLink, String(kind)).toBe(wanted);
      }
    });
  });

  it('accept → creates the remote event and persists a booking_reference', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();

    await (effects as unknown as Awaitable).writeEvent(uid);

    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]!.connectionRef).toBe(CAL_REF);
    // The host first, as organizer, then the guest (a host's verdict: the event
    // has to show who it is with, host then guest).
    expect(provider.created[0]!.attendeeEmails).toEqual(['alex@example.com', 'sam@example.com']);
    expect(provider.created[0]!.organizerEmail).toBe('alex@example.com');
    // No location kind on the booking: an online meeting, so the organizer's
    // calendar is asked for a room (F4, 2026-10-30 production E2E).
    expect(provider.created[0]!.requestConferenceLink).toBe(true);

    const refs = await db.all<{ external_event_id: string; meeting_url: string }>(
      sql`SELECT br.external_event_id, br.meeting_url
          FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid}`,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.external_event_id).toBe('evt-1');
  });

  // Release #322 review: a retried change must not let the guest hear from the
  // provider twice (once from the retry, once from the reinvite), and a refused
  // email must still leave them hearing once.
  describe('one provider notice per change, across retries', () => {
    const GUEST = 'sam@example.com';
    const queueInviteeEmail = (uid: string, action: string) =>
      enqueueOutbox(db, { kind: 'email', action, bookingUid: uid, orderKey: `${uid}|attendee` });

    /** A collective booking: the organizer plus Jordan, each with a destination calendar. */
    async function teamBooking(): Promise<string> {
      const uid = await bookFirstSlot();
      const jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`))!.id;
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      for (const m of [memberId, jordan]) {
        await db.run(sql`INSERT INTO booking_host (id, booking_id, member_id, created_at) VALUES (${randomUUID()}, ${bookingId}, ${m}, ${Date.now()})`);
      }
      if (!(await db.get(sql`SELECT 1 AS ok FROM connected_calendar WHERE member_id = ${jordan}`))) {
        await db.run(
          sql`INSERT INTO connected_calendar
                (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
              VALUES (${randomUUID()}, ${accountId}, ${jordan}, ${'google'}, ${'cal-dest-2'}, ${null}, ${1}, ${1}, ${Date.now()})`,
        );
      }
      return uid;
    }

    /** A calendar change row marked with a fresh invitee email, run the way the worker runs it. */
    async function change(effects: CalendarEffects, uid: string, action: 'create' | 'reschedule') {
      const emailId = await queueInviteeEmail(uid, action === 'create' ? 'confirmation' : 'reschedule');
      const rowId = await enqueueOutbox(db, { kind: 'calendar', action, bookingUid: uid });
      await tagCalendarChangeWithInviteeEmail(db, { bookingUid: uid, action, emailOutboxId: emailId });
      let attempts = 0;
      const payload = async () => (await listOutbox(db, { kind: 'calendar', bookingUid: uid })).find((r) => r.id === rowId)!.payload;
      return {
        emailId,
        run: async () => effects.runCalendarJob(action, uid, await payload(), { id: rowId, attempts: attempts++ }),
        refuse: () => db.run(sql`UPDATE outbox SET status = 'skipped' WHERE id = ${emailId}`),
        finish: async () => {
          await markOutboxDone(db, rowId);
          await effects.runCalendarJob('reinvite', uid, JSON.stringify({ inviteeEmailId: emailId }), { id: 'reinvite', attempts: 0 });
        },
      };
    }

    const failOnce = (provider: NotifyingCalendarProvider, op: 'create' | 'update', ref: string) => {
      let failed = false;
      provider.fail = (o, r) => {
        if (failed || o !== op || r !== ref) return false;
        failed = true;
        return true;
      };
    };

    const moveBooking = (uid: string) =>
      db.run(sql`UPDATE booking SET start_ms = start_ms + 3600000, end_ms = end_ms + 3600000 WHERE uid = ${uid}`);

    it("only the organizer's event notifies the guest; a co-host's copy never does", async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const write = effects as unknown as Awaitable;
      await write.writeEvent(uid);
      await moveBooking(uid);
      await write.moveEvent(uid);
      await write.removeEvent(uid);
      expect(provider.notices.map((n) => `${n.kind}:${n.ref}`)).toEqual([
        `invite:${CAL_REF}`,
        `update:${CAL_REF}`,
        `cancel:${CAL_REF}`,
      ]);
      expect(provider.created.find((c) => c.connectionRef === 'cal-dest-2')!.sendInvitations).toBe(false);
    });

    it('create: the organizer written quietly, a co-host failing, the email refused: one notice, from the reinvite', async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const c = await change(effects, uid, 'create');
      failOnce(provider, 'create', 'cal-dest-2');
      await expect(c.run()).rejects.toThrow('vendor 503');
      await c.refuse();
      await c.run();
      expect(provider.notices).toHaveLength(0);
      await c.finish();
      expect(provider.notices).toEqual([{ to: GUEST, kind: 'invite', ref: CAL_REF }]);
    });

    it("create: the organizer's create failing, the email refused: the retry notifies, no reinvite on top", async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const c = await change(effects, uid, 'create');
      failOnce(provider, 'create', CAL_REF);
      await expect(c.run()).rejects.toThrow('vendor 503');
      await c.refuse();
      await c.run();
      await c.finish();
      expect(provider.notices).toEqual([{ to: GUEST, kind: 'invite', ref: CAL_REF }]);
    });

    it('move: the organizer moved quietly, a co-host failing, the email refused: one notice, from the reinvite', async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const created = await change(effects, uid, 'create');
      await created.run();
      await moveBooking(uid);
      const c = await change(effects, uid, 'reschedule');
      failOnce(provider, 'update', 'cal-dest-2');
      await expect(c.run()).rejects.toThrow('vendor 503');
      await c.refuse();
      // The retry invites, but saving the organizer's event at the time it
      // already has tells nobody: the reinvite still has to.
      await c.run();
      expect(provider.notices).toHaveLength(0);
      await c.finish();
      expect(provider.notices).toEqual([{ to: GUEST, kind: 'invite', ref: CAL_REF }]);
    });

    it("move: the organizer's move failing, the email refused: the retry's move notifies, no reinvite on top", async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const created = await change(effects, uid, 'create');
      await created.run();
      await moveBooking(uid);
      const c = await change(effects, uid, 'reschedule');
      failOnce(provider, 'update', CAL_REF);
      await expect(c.run()).rejects.toThrow('vendor 503');
      await c.refuse();
      await c.run();
      await c.finish();
      expect(provider.notices).toEqual([{ to: GUEST, kind: 'update', ref: CAL_REF }]);
    });

    it('a refused email on a change that went through in one go: one notice, from the reinvite', async () => {
      for (const action of ['create', 'reschedule'] as const) {
        const provider = new NotifyingCalendarProvider([GUEST]);
        const effects = new CalendarEffects(provider, db);
        const uid = await teamBooking();
        if (action === 'reschedule') {
          await (await change(effects, uid, 'create')).run();
          await moveBooking(uid);
        }
        const c = await change(effects, uid, action);
        await c.run();
        await c.refuse();
        await c.finish();
        expect(provider.notices, action).toEqual([{ to: GUEST, kind: 'invite', ref: CAL_REF }]);
      }
    });

    it('an email that went out leaves the provider silent on every change', async () => {
      const provider = new NotifyingCalendarProvider([GUEST]);
      const effects = new CalendarEffects(provider, db);
      const uid = await teamBooking();
      const created = await change(effects, uid, 'create');
      await created.run();
      await markOutboxDone(db, created.emailId);
      await created.finish();
      await moveBooking(uid);
      const moved = await change(effects, uid, 'reschedule');
      await moved.run();
      await markOutboxDone(db, moved.emailId);
      await moved.finish();
      expect(provider.notices).toHaveLength(0);
    });
  });

  describe('the organizer is in the guest list, first and once', () => {
    it('on a personal booking, and the reschedule keeps it', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      await (effects as unknown as Awaitable).moveEvent(uid);
      for (const body of [provider.created[0]!, provider.updated[0]!]) {
        expect(body.attendeeEmails[0]).toBe(body.organizerEmail);
        expect(body.attendeeEmails.filter((e) => e.toLowerCase() === 'alex@example.com')).toHaveLength(1);
        expect(body.attendeeEmails).toContain('sam@example.com');
      }
    });

    it('once, even when the guest books with the host address in other case', async () => {
      const provider = new RecordingCalendarProvider();
      const uid = await bookFirstSlot();
      await db.run(sql`UPDATE booking_attendee SET email = 'ALEX@example.com'
                       WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`);
      await (new CalendarEffects(provider, db) as unknown as Awaitable).writeEvent(uid);
      expect(provider.created[0]!.attendeeEmails).toEqual(['alex@example.com']);
    });

    it("on a team booking: first on the organizer's event, and never on a co-host's copy", async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      // A collective booking: the primary host plus a co-host in booking_host,
      // each with their own destination calendar.
      const jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`))!.id;
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      for (const m of [memberId, jordan]) {
        await db.run(sql`INSERT INTO booking_host (id, booking_id, member_id, created_at) VALUES (${randomUUID()}, ${bookingId}, ${m}, ${Date.now()})`);
      }
      await db.run(
        sql`INSERT INTO connected_calendar
              (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${jordan}, ${'google'}, ${'cal-dest-2'}, ${null}, ${1}, ${1}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).writeEvent(uid);
      expect(provider.created.map((c) => c.connectionRef)).toEqual([CAL_REF, 'cal-dest-2']);
      // The organizer's own event: organizer first, then the guest, then the co-host.
      expect(provider.created[0]!.attendeeEmails).toEqual(['alex@example.com', 'sam@example.com', 'jordan@example.com']);
      // The co-host's copy: the list it always had. Listing the organizer there
      // would invite them to a second copy of an event they already own.
      expect(provider.created[1]!.attendeeEmails).toEqual(['sam@example.com', 'jordan@example.com']);
      // The reschedule keeps the same split.
      await (effects as unknown as Awaitable).moveEvent(uid);
      const byRef = Object.fromEntries(provider.updated.map((u) => [u.connectionRef, u.attendeeEmails]));
      expect(byRef[CAL_REF]).toEqual(['alex@example.com', 'sam@example.com', 'jordan@example.com']);
      expect(byRef['cal-dest-2']).toEqual(['sam@example.com', 'jordan@example.com']);
      // The room is requested on the organizer's destination only (no location
      // kind: an online meeting).
      expect(provider.created.map((c) => !!c.requestConferenceLink)).toEqual([true, false]);
    });

    it('stays on their event after they switch destination calendar, on the reschedule', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      // The host makes another of their calendars the destination; the event
      // already written stays on the old one, which is still theirs.
      await db.run(sql`UPDATE connected_calendar SET is_destination = 0 WHERE external_id = ${CAL_REF}`);
      await db.run(
        sql`INSERT INTO connected_calendar
              (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'google'}, ${'cal-dest-new'}, ${null}, ${1}, ${1}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).moveEvent(uid);
      expect(provider.updated.map((u) => u.connectionRef)).toEqual([CAL_REF]);
      expect(provider.updated[0]!.attendeeEmails).toEqual(['alex@example.com', 'sam@example.com']);
    });
  });

  it('DH1: a retried/concurrent write is idempotent — no duplicate external event', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();

    // Two sequential writes (retry) and two concurrent writes (race) must all
    // collapse to a SINGLE createEvent + a single reference for the destination.
    await (effects as unknown as Awaitable).writeEvent(uid);
    await (effects as unknown as Awaitable).writeEvent(uid);
    await Promise.all([
      (effects as unknown as Awaitable).writeEvent(uid),
      (effects as unknown as Awaitable).writeEvent(uid),
    ]);

    expect(provider.created).toHaveLength(1);
    const refs = await db.all(
      sql`SELECT br.id FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid} AND br.destination = ${CAL_REF}`,
    );
    expect(refs).toHaveLength(1);
  });

  it('cancel → deletes the remote event and clears the reference', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    await (effects as unknown as Awaitable).writeEvent(uid);

    await (effects as unknown as Awaitable).removeEvent(uid);

    expect(provider.deleted).toHaveLength(1);
    expect(provider.deleted[0]!.externalEventId).toBe('evt-1');
    expect(provider.deleted[0]!.connectionRef).toBe(CAL_REF);
    const refs = await db.all(
      sql`SELECT br.id FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid}`,
    );
    expect(refs).toHaveLength(0);
  });

  it('reschedule → MOVES the same external event in place (no delete, no duplicate)', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    await (effects as unknown as Awaitable).writeEvent(uid);
    expect(provider.created).toHaveLength(1);

    await (effects as unknown as Awaitable).moveEvent(uid);

    // The event was UPDATED in place — same external id, nothing deleted, no re-create.
    expect(provider.updated).toHaveLength(1);
    expect(provider.updated[0]!.externalEventId).toBe('evt-1');
    expect(provider.updated[0]!.connectionRef).toBe(CAL_REF);
    expect(provider.created).toHaveLength(1);
    expect(provider.deleted).toHaveLength(0);
    // The single reference row is preserved (still evt-1).
    const refs = await db.all<{ external_event_id: string }>(
      sql`SELECT br.external_event_id FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid}`,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.external_event_id).toBe('evt-1');
  });

  it('create → reschedule preserves a selected secondary calendar when the provider omits its id', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    const secondaryCalendarId = 'provider-secondary-calendar';
    await db.run(
      sql`UPDATE booking
          SET metadata = ${JSON.stringify({
            _destinationCalendar: {
              connectionRef: CAL_REF,
              externalId: secondaryCalendarId,
            },
          })}
          WHERE uid = ${uid}`,
    );

    await (effects as unknown as Awaitable).writeEvent(uid);
    await (effects as unknown as Awaitable).moveEvent(uid);

    expect(provider.created[0]!.connectionRef).toBe(CAL_REF);
    expect(provider.created[0]!.calendarId).toBe(secondaryCalendarId);
    expect(provider.updated[0]!.connectionRef).toBe(CAL_REF);
    expect(provider.updated[0]!.calendarId).toBe(secondaryCalendarId);
    const ref = await db.get<{ external_calendar_id: string | null }>(
      sql`SELECT br.external_calendar_id
          FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid}`,
    );
    expect(ref!.external_calendar_id).toBe(secondaryCalendarId);
  });

  it('reschedule with nothing created yet falls back to a fresh create', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();

    await (effects as unknown as Awaitable).moveEvent(uid);

    expect(provider.updated).toHaveLength(0);
    expect(provider.created).toHaveLength(1);
  });

  it('B9: requests a conferencing link when the booking\'s location KIND is conferencing', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    await db.run(sql`UPDATE booking SET location_kind = 'conferencing' WHERE uid = ${uid}`);

    await (effects as unknown as Awaitable).writeEvent(uid);
    expect(provider.created[0]!.requestConferenceLink).toBe(true);
  });

  it('B9: a non-conferencing kind never requests a link', async () => {
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    await db.run(
      sql`UPDATE booking SET location_kind = 'in_person', location = 'HQ' WHERE uid = ${uid}`,
    );

    await (effects as unknown as Awaitable).writeEvent(uid);
    expect(provider.created[0]!.requestConferenceLink).toBe(false);
  });

  it('B9: the retired legacy token in `location` no longer triggers a link on its own', async () => {
    // The old trigger read booking.location. The migration backfills the kind
    // for rows that already carried the token; after that the KIND is the only
    // trigger, so a booking whose kind is not an online one mints no link
    // whatever its location text says.
    const provider = new RecordingCalendarProvider();
    const effects = new CalendarEffects(provider, db);
    const uid = await bookFirstSlot();
    await db.run(
      sql`UPDATE booking SET location = ${LEGACY_CONFERENCING_VALUE}, location_kind = ${'in_person'} WHERE uid = ${uid}`,
    );

    await (effects as unknown as Awaitable).writeEvent(uid);
    expect(provider.created[0]!.requestConferenceLink).toBe(false);
  });

  it('disabled provider (OSS default) is a strict no-op — no writes, no references', async () => {
    const disabled: CalendarProvider = {
      enabled: false,
      listBusy: () => Promise.resolve([]),
      createEvent: () => {
        throw new Error('must not be called');
      },
      updateEvent: () => {
        throw new Error('must not be called');
      },
      deleteEvent: () => {
        throw new Error('must not be called');
      },
      listCalendars: () => Promise.resolve([]),
      checkConnection: () => Promise.resolve({ ok: false, detail: 'disabled' }),
    };
    const effects = new CalendarEffects(disabled, db);
    const uid = await bookFirstSlot();

    // Fire-and-forget public methods must not throw and must not touch the port.
    effects.onBookingAccepted(uid);
    effects.onBookingCancelled(uid);
    effects.onBookingRescheduled(uid);

    const refs = await db.all(
      sql`SELECT br.id FROM booking_reference br JOIN booking b ON b.id = br.booking_id
          WHERE b.uid = ${uid}`,
    );
    expect(refs).toHaveLength(0);
  });

  describe('the title and description templates reach the event', () => {
    const JOIN = getMessages('en').manage.joinMeeting;

    async function withTemplates(title: string | null, description: string | null): Promise<void> {
      await db.run(
        sql`UPDATE event_type SET calendar_title_template = ${title}, calendar_description_template = ${description}
            WHERE slug = 'intro-call'`,
      );
    }

    it("on the organizer's event and its move, as rendered at booking time", async () => {
      await withTemplates('Reunión Alex - {{name}}', 'Company: {{form.company}}\nGuest: {{attendee_email}}');
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      await (effects as unknown as Awaitable).moveEvent(uid);
      for (const body of [provider.created[0]!, provider.updated[0]!]) {
        expect(body.title).toBe('Reunión Alex - Sam Guest');
        expect(body.description).toBe('Company: Acme\nGuest: sam@example.com');
      }
    });

    it("on a co-host's copy, above the organizer's room", async () => {
      await withTemplates(null, 'Company: {{form.company}}');
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      const jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'jordan-lee'`))!.id;
      const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
      await db.run(sql`UPDATE booking SET location_kind = 'conferencing' WHERE id = ${bookingId}`);
      for (const m of [memberId, jordan]) {
        await db.run(sql`INSERT INTO booking_host (id, booking_id, member_id, created_at) VALUES (${randomUUID()}, ${bookingId}, ${m}, ${Date.now()})`);
      }
      await db.run(
        sql`INSERT INTO connected_calendar
              (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${jordan}, ${'google'}, ${'cal-dest-2'}, ${null}, ${1}, ${1}, ${Date.now()})`,
      );
      await (effects as unknown as Awaitable).writeEvent(uid);
      expect(provider.created.map((c) => c.description)).toEqual([
        'Company: Acme',
        `Company: Acme\n\n${JOIN}: https://meet/x`,
      ]);
      await (effects as unknown as Awaitable).moveEvent(uid);
      const byRef = Object.fromEntries(provider.updated.map((u) => [u.connectionRef, u.description]));
      expect(byRef).toEqual({ [CAL_REF]: 'Company: Acme', 'cal-dest-2': `Company: Acme\n\n${JOIN}: https://meet/x` });
    });

    it('without one: no body on the organizer event, and a move sends none, as before', async () => {
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      await (effects as unknown as Awaitable).moveEvent(uid);
      expect(provider.created[0]!.title).toBe('Intro Call');
      expect(provider.created[0]!.description).toBeNull();
      expect('description' in provider.updated[0]!).toBe(false);
    });

    it('a body the template no longer writes is cleared on the move, the join line kept', async () => {
      await withTemplates(null, 'Company: {{form.company}}');
      const provider = new RecordingCalendarProvider();
      const effects = new CalendarEffects(provider, db);
      const uid = await bookFirstSlot();
      await (effects as unknown as Awaitable).writeEvent(uid);
      // What `applyCalendarTemplates` stores once the template is gone.
      await db.run(sql`UPDATE booking SET calendar_description = '' WHERE uid = ${uid}`);
      await (effects as unknown as Awaitable).moveEvent(uid);
      expect(provider.updated[0]!.description).toBe('');
      expect(eventBody({ description: '', organizerLocale: 'en' }, 'https://m')).toBe(`${JOIN}: https://m`);
    });

    it('eventBody joins the description and the room, and is null with neither', () => {
      expect(eventBody({ description: null, organizerLocale: 'en' }, null)).toBeNull();
      expect(eventBody({ description: 'D', organizerLocale: 'en' }, null)).toBe('D');
      expect(eventBody({ description: null, organizerLocale: 'es' }, 'https://m')).toBe(
        `${getMessages('es').manage.joinMeeting}: https://m`,
      );
    });
  });
});
