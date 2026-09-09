import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createBooking,
  createDb,
  claimBookingDestination,
  crmDestination,
  disconnectAccountIntegration,
  fillBookingReference,
  getAccountIntegration,
  getAvailability,
  listOutbox,
  loadBookingReferences,
  migrate,
  seed,
  sql,
  upsertAccountIntegration,
  loadEncryptionKey,
  type Db,
} from '@slate/db';
import {
  CrmAuthError,
  CrmPropertyError,
  DisabledCrmProvider,
  type CrmContactInput,
  type CrmContactResult,
  type CrmMeetingInput,
  type CrmMeetingUpdate,
  type CrmProvider,
} from '@slate/crm';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { CalendarEffects } from './calendar-effects';
import { CrmEffects } from './crm-effects';
import { OutboxWorker } from './outbox.worker';

/**
 * Seams D and E — enqueue, and delivery through the worker.
 *
 * The load-bearing assertions are (a) which rows exist in `outbox` after a
 * lifecycle call and that NO outbound call was made, which is how invariant 5
 * gets a test rather than a promise, and (b) that a replay creates nothing,
 * which is the no-duplicate-meeting guarantee.
 */
const KEY_B64 = randomBytes(32).toString('base64');
const KEY = loadEncryptionKey(KEY_B64);
const TOKEN = 'pat-live-test-0000-4242';

const ENV: ServerEnv = loadServerEnv({
  NODE_ENV: 'test',
  CRM_PROVIDER: 'hubspot',
  INTEGRATION_ENCRYPTION_KEY: KEY_B64,
} as NodeJS.ProcessEnv);

/** A recording CRM whose every step can be made to fail in a chosen way. */
class FakeCrmProvider implements CrmProvider {
  readonly enabled = true;
  readonly name = 'hubspot';
  readonly requiredScopes: readonly string[] = [
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
  ];
  readonly contacts: CrmContactInput[] = [];
  readonly meetings: CrmMeetingInput[] = [];
  readonly updates: CrmMeetingUpdate[] = [];
  /** Emails the CRM already knows — resolved without a create. */
  known = new Set<string>();
  failCreateWith: Error | null = null;
  private seq = 0;

  verifyCredential(): Promise<void> {
    return Promise.resolve();
  }
  resolveContact(input: CrmContactInput): Promise<CrmContactResult> {
    this.contacts.push(input);
    return Promise.resolve({ contactId: 'contact-1', created: !this.known.has(input.email) });
  }
  createMeeting(input: CrmMeetingInput): Promise<{ meetingId: string }> {
    if (this.failCreateWith) {
      const err = this.failCreateWith;
      this.failCreateWith = null;
      return Promise.reject(err);
    }
    this.meetings.push(input);
    return Promise.resolve({ meetingId: `meet-${++this.seq}` });
  }
  updateMeeting(input: CrmMeetingUpdate): Promise<void> {
    this.updates.push(input);
    return Promise.resolve();
  }
}

describe('CrmEffects (H1a, #92)', () => {
  let db: Db;
  let accountId: string;
  let crm: FakeCrmProvider;
  let effects: CrmEffects;

  function makeWorker(e: CrmEffects): OutboxWorker {
    return new OutboxWorker(
      db,
      ENV,
      new CalendarEffects(new DisabledCalendar(), db),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db),
      new DaptaSyncEffects(ENV),
      e,
    );
  }

  async function bookFirstSlot(): Promise<string> {
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
      startMs: new Date(avail!.slots[0]!.startUtc).getTime(),
      attendee: { name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    if (!booked.ok) throw new Error('seed booking failed');
    return booked.booking.uid;
  }

  /**
   * The row a new-uid reschedule leaves behind: a fresh booking pointing back at
   * the one it replaced. Built directly rather than through the v2 service so
   * this spec tests the CRM seam and not the reschedule contract.
   */
  async function bookSuccessorOf(oldUid: string): Promise<string> {
    const old = (await db.get<{ id: string; event_type_id: string; host_member_id: string; title: string; start_ms: number; end_ms: number }>(
      sql`SELECT id, event_type_id, host_member_id, title, start_ms, end_ms FROM booking WHERE uid = ${oldUid}`,
    ))!;
    const id = randomUUID();
    const uid = randomUUID();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO booking
            (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms,
             status, responses, rescheduled_from_uid, created_at, updated_at)
          VALUES (${id}, ${accountId}, ${uid}, ${old.event_type_id}, ${old.host_member_id},
            ${old.title}, ${Number(old.start_ms) + 86_400_000}, ${Number(old.end_ms) + 86_400_000},
            'accepted', ${'{"company":"Acme"}'}, ${oldUid}, ${now}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, created_at)
          VALUES (${randomUUID()}, ${id}, 'Ada Lovelace', 'ada@example.com', 'America/New_York', ${now})`,
    );
    return uid;
  }

  /**
   * The lifecycle hooks are fire-and-forget by design — they must never make a
   * booking wait on an INSERT. So a test has to let the enqueue land before it
   * inspects the queue.
   */
  const settle = () => new Promise((r) => setImmediate(r));

  /** Drain until nothing is pending, so a backoff never leaves work behind. */
  async function drain(worker: OutboxWorker, passes = 4): Promise<void> {
    await settle();
    for (let i = 0; i < passes; i++) await worker.drainOnce(Date.now() + i * 600_000);
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    crm = new FakeCrmProvider();
    effects = new CrmEffects(crm, db, ENV);
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
  });

  // --- Seam D: enqueue only, never inline (invariant 5) --------------------

  it('an accepted booking enqueues ONE crm row and calls nothing', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await settle();

    const rows = await listOutbox(db, { kind: 'crm' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('booking_write_out');
    expect(rows[0]!.bookingUid).toBe(uid);
    // The whole point of the outbox: a CRM outage can never fail or slow a
    // booking, because the request path made no CRM call at all.
    expect(crm.contacts).toHaveLength(0);
    expect(crm.meetings).toHaveLength(0);
  });

  it('cancel and reschedule each enqueue their own row', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingCancelled(uid);
    effects.onBookingRescheduled(uid);
    await settle();

    const actions = (await listOutbox(db, { kind: 'crm' })).map((r) => r.action).sort();
    expect(actions).toEqual(['booking_cancel', 'booking_reschedule']);
  });

  // Clone-and-run: a bare fork's behaviour is unchanged by this seam existing.
  it('a disabled provider enqueues nothing', async () => {
    const uid = await bookFirstSlot();
    const disabled = new CrmEffects(new DisabledCrmProvider(), db, ENV);
    disabled.onBookingAccepted(uid);
    disabled.onBookingCancelled(uid);
    await settle();
    expect(await listOutbox(db, { kind: 'crm' })).toHaveLength(0);
  });

  /**
   * The account is what a disconnect sweeps by. This is asserted here, on rows
   * the LIFECYCLE produced, rather than in the db-layer spec on rows a test
   * built by hand — the hand-built ones carried an account by construction and
   * so could never catch an enqueue that omitted it.
   */
  it('stamps the booking\'s account on the row, so a later disconnect can find it', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await settle();
    expect((await listOutbox(db, { kind: 'crm' }))[0]!.accountId).toBe(accountId);
  });

  it('disconnecting skips the rows the lifecycle actually enqueued', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await settle();
    expect((await listOutbox(db, { kind: 'crm' }))[0]!.status).toBe('pending');

    await disconnectAccountIntegration(db, accountId, 'hubspot');

    const row = (await listOutbox(db, { kind: 'crm' }))[0]!;
    expect(row.status).toBe('skipped');
    expect(row.lastError).toContain('disconnected');
  });

  // --- Seam E: delivery ----------------------------------------------------

  it('resolves the contact then creates the associated meeting, and records the reference', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    expect(crm.contacts).toHaveLength(1);
    expect(crm.contacts[0]).toMatchObject({
      token: TOKEN,
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(crm.meetings).toHaveLength(1);
    expect(crm.meetings[0]!.contactId).toBe('contact-1');
    // The intake answer reaches the body as `label: answer`, and the uid is the
    // reference rather than a manage link.
    expect(crm.meetings[0]!.body).toContain('Acme');
    expect(crm.meetings[0]!.body).toContain(uid);
    expect(crm.meetings[0]!.body).not.toContain('token=');

    const rows = await listOutbox(db, { kind: 'crm' });
    expect(rows[0]!.status).toBe('done');

    const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
    const ref = (await loadBookingReferences(db, bookingId)).find((r) => r.type === 'crm');
    expect(ref?.externalEventId).toBe('meet-1');
    const integration = await getAccountIntegration(db, accountId, 'hubspot');
    expect(ref?.destination).toBe(crmDestination(integration!.id));
  });

  it('marks the integration healthy after a successful write-out', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));
    const integration = await getAccountIntegration(db, accountId, 'hubspot');
    expect(integration?.status).toBe('connected');
    expect(integration?.lastCheckOk).toBe(true);
  });

  /**
   * The DH1 claim, stated as a test. This is the guarantee that stands between
   * a retry and two meetings on one contact's timeline.
   */
  it('a replayed write-out creates NOTHING a second time', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));
    expect(crm.meetings).toHaveLength(1);

    // Same booking enqueued again — a re-confirm, or a redelivered row.
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));
    expect(crm.meetings).toHaveLength(1);
    expect(crm.contacts).toHaveLength(1);
  });

  it('releases its claim when the meeting create fails, so the retry re-creates', async () => {
    const uid = await bookFirstSlot();
    crm.failCreateWith = new Error('hubspot POST → 503');
    effects.onBookingAccepted(uid);

    const worker = makeWorker(effects);
    await settle();
    const t0 = Date.now();
    await worker.drainOnce(t0);
    let rows = await listOutbox(db, { kind: 'crm' });
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(1);
    expect(crm.meetings).toHaveLength(0);

    await worker.drainOnce(t0 + 600_000);
    rows = await listOutbox(db, { kind: 'crm' });
    expect(rows[0]!.status).toBe('done');
    expect(crm.meetings).toHaveLength(1);
  });

  it('a contact the CRM already knows is resolved without a create', async () => {
    crm.known.add('ada@example.com');
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));
    // The adapter owns "search then create"; what this asserts is that the
    // effect asked for a RESOLUTION and did not force an identity write.
    expect(crm.contacts).toHaveLength(1);
    expect(crm.meetings).toHaveLength(1);
  });

  it('drops the body and retries once when the CRM rejects an unknown property', async () => {
    const uid = await bookFirstSlot();
    crm.failCreateWith = new CrmPropertyError('Property "hs_meeting_body" does not exist', 'hs_meeting_body');
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(1);
    expect(crm.meetings[0]!.body).toBe('');
    expect((await listOutbox(db, { kind: 'crm' }))[0]!.status).toBe('done');
  });

  // --- Cancel and reschedule ----------------------------------------------

  it('cancel PATCHes the meeting the write-out created, and never a second one', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    effects.onBookingCancelled(uid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(1);
    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.meetingId).toBe('meet-1');
    expect(crm.updates[0]!.outcome).toBe('canceled');
    expect(crm.updates[0]!.title).toContain('[Canceled]');
  });

  it('reschedule moves the SAME meeting and leaves the title alone', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    effects.onBookingRescheduled(uid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(1);
    expect(crm.updates[0]!.meetingId).toBe('meet-1');
    expect(crm.updates[0]!.outcome).toBe('scheduled');
    expect(crm.updates[0]!.title).toBeUndefined();
    expect(crm.updates[0]!.startUtc).toBeTruthy();
  });

  // #63: cancelling a booking that was never written out is a no-op.
  it('cancelling a booking that was never written out calls nothing and succeeds', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingCancelled(uid);
    await drain(makeWorker(effects));

    expect(crm.updates).toHaveLength(0);
    expect((await listOutbox(db, { kind: 'crm' }))[0]!.status).toBe('done');
  });

  /**
   * The new-uid reschedule contract mints a NEW booking row, so the meeting is
   * recorded against the PREDECESSOR's booking id. Without the adoption walk
   * the successor looks like a booking that was never written out, and the
   * contact ends up holding a stale meeting at the old time plus a second one
   * at the new — precisely the duplicate #63 forbids.
   */
  it('adopts the predecessor\'s meeting on a new-uid reschedule instead of creating a second', async () => {
    const oldUid = await bookFirstSlot();
    effects.onBookingAccepted(oldUid);
    await drain(makeWorker(effects));
    expect(crm.meetings).toHaveLength(1);

    const newUid = await bookSuccessorOf(oldUid);
    effects.onBookingRescheduled(newUid);
    await drain(makeWorker(effects));

    // ONE meeting, moved. Not a second one.
    expect(crm.meetings).toHaveLength(1);
    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.meetingId).toBe('meet-1');
    expect(crm.updates[0]!.outcome).toBe('scheduled');

    // The successor now names the same meeting, so a later cancel finds it.
    const newId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${newUid}`))!.id;
    const ref = (await loadBookingReferences(db, newId)).find((r) => r.type === 'crm');
    expect(ref?.externalEventId).toBe('meet-1');
  });

  it('cancels the adopted meeting when the successor is later cancelled', async () => {
    const oldUid = await bookFirstSlot();
    effects.onBookingAccepted(oldUid);
    await drain(makeWorker(effects));
    const newUid = await bookSuccessorOf(oldUid);
    effects.onBookingRescheduled(newUid);
    await drain(makeWorker(effects));

    effects.onBookingCancelled(newUid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(1);
    expect(crm.updates.at(-1)!.meetingId).toBe('meet-1');
    expect(crm.updates.at(-1)!.outcome).toBe('canceled');
  });

  // Accepted and rescheduled before the write-out drained: there is no meeting
  // anywhere to adopt, so a fresh create is right — mirroring the calendar seam.
  it('creates a fresh meeting when neither the successor nor its predecessor has one', async () => {
    const oldUid = await bookFirstSlot();
    const newUid = await bookSuccessorOf(oldUid);
    effects.onBookingRescheduled(newUid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(1);
    expect(crm.updates).toHaveLength(0);
  });

  /**
   * The two seams SHARE `booking_reference`, on purpose: one table, one
   * no-duplicates guarantee. That only holds while each reader says which kind
   * it wants. A calendar teardown that took every row would hand a CRM meeting
   * id to the calendar provider and then delete the reference the CRM needs to
   * cancel its meeting — on exactly the deployments that run both.
   */
  it('a calendar cancel leaves the CRM reference alone', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${uid}`))!.id;
    // A calendar event alongside the CRM meeting, as a real deployment has.
    const calendarClaim = await claimBookingDestination(db, bookingId, 'cal-dest-1', 'calendar_event');
    await fillBookingReference(db, calendarClaim!, {
      externalEventId: 'evt-1',
      externalCalendarId: null,
      meetingUrl: null,
    });

    const calendar = new CalendarEffects(new RecordingCalendar(), db);
    await calendar.runCalendarJob('delete', uid);

    const left = await loadBookingReferences(db, bookingId);
    expect(left.map((r) => r.type)).toEqual(['crm']);
    expect(left[0]!.externalEventId).toBe('meet-1');

    // And the CRM cancel that follows still finds its meeting.
    effects.onBookingCancelled(uid);
    await drain(makeWorker(effects));
    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.meetingId).toBe('meet-1');
  });

  it('a calendar delete is never handed the CRM meeting id', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    const recording = new RecordingCalendar();
    await new CalendarEffects(recording, db).runCalendarJob('delete', uid);
    expect(recording.deleted).toEqual([]);
  });

  /**
   * A write-out row can outlive the state it was enqueued for. Creating a
   * meeting for a booking that is already cancelled leaves a record at the old
   * time that nothing ever cancels — the duplicate #63 forbids, arriving by the
   * back door.
   */
  it('refuses to create a meeting for a booking that is no longer accepted', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await settle();
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid}`);

    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(0);
    const row = (await listOutbox(db, { kind: 'crm' }))[0]!;
    expect(row.status).toBe('skipped');
    expect(row.lastError).toContain('not accepted');
  });

  /**
   * The reschedule path ALSO creates (adopt-or-write-out), so gating only the
   * write-out moved the orphan rather than closing it. Reachable with no race
   * at all: adding a guest to a PENDING booking enqueues a reschedule.
   */
  it('refuses to create a meeting on a reschedule for a booking that is not accepted', async () => {
    const uid = await bookFirstSlot();
    await db.run(sql`UPDATE booking SET status = 'pending' WHERE uid = ${uid}`);

    effects.onBookingRescheduled(uid);
    await drain(makeWorker(effects));

    expect(crm.meetings).toHaveLength(0);
    const row = (await listOutbox(db, { kind: 'crm' }))[0]!;
    expect(row.status).toBe('skipped');
    expect(row.lastError).toContain('not accepted');
  });

  // A cancel is exactly the case where the booking is NOT accepted, so it must
  // never be caught by that gate.
  it('still cancels the meeting of a booking that is already cancelled', async () => {
    const uid = await bookFirstSlot();
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid}`);
    effects.onBookingCancelled(uid);
    await drain(makeWorker(effects));

    expect(crm.updates).toHaveLength(1);
    expect(crm.updates[0]!.outcome).toBe('canceled');
  });

  // --- Terminal vs retryable ----------------------------------------------

  /**
   * A missing scope flips the integration unhealthy carrying the STRUCTURED
   * error, and the row STOPS. Retrying a 403 cannot succeed, and burning five
   * attempts against it just fills the delivery log.
   */
  it('a 403 marks the integration unhealthy with the scope list and does not retry', async () => {
    const uid = await bookFirstSlot();
    crm.failCreateWith = new CrmAuthError('missing scopes', 403, 'MISSING_SCOPES', [
      'crm.objects.contacts.write',
    ]);
    effects.onBookingAccepted(uid);
    await drain(makeWorker(effects));

    const rows = await listOutbox(db, { kind: 'crm' });
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.lastError).toContain('crm.objects.contacts.write');
    expect(rows[0]!.attempts).toBe(0);

    const integration = await getAccountIntegration(db, accountId, 'hubspot');
    expect(integration?.status).toBe('unhealthy');
    expect(integration?.lastErrorDetail).toEqual({
      category: 'MISSING_SCOPES',
      requiredGranularScopes: ['crm.objects.contacts.write'],
    });
    // Never auto-disabled (#63): fixing the scope in the portal is enough.
    expect(integration?.status).not.toBe('disconnected');
  });

  it('a 5xx retries with backoff rather than being dropped', async () => {
    const uid = await bookFirstSlot();
    crm.failCreateWith = new Error('hubspot POST → 500');
    effects.onBookingAccepted(uid);

    const worker = makeWorker(effects);
    await settle();
    await worker.drainOnce(Date.now());
    const rows = await listOutbox(db, { kind: 'crm' });
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.lastError).toContain('500');
    expect(rows[0]!.nextAttemptAt).toBeGreaterThan(0);
  });

  // A decision, not a failure: nobody connected a CRM.
  it('marks the row skipped when no credential is connected', async () => {
    const db2 = await createDb('file::memory:');
    await migrate(db2);
    await seed(db2);
    const bare = new CrmEffects(crm, db2, loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
    const avail = await getAvailability(db2, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const booked = await createBooking(db2, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: new Date(avail!.slots[0]!.startUtc).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Bare Fork Co' },
    });
    if (!booked.ok) throw new Error('seed booking failed');

    bare.onBookingAccepted(booked.booking.uid);
    await settle();
    const worker = new OutboxWorker(
      db2,
      ENV,
      new CalendarEffects(new DisabledCalendar(), db2),
      new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db2),
      new DaptaSyncEffects(ENV),
      bare,
    );
    await worker.drainOnce(Date.now());

    const rows = await listOutbox(db2, { kind: 'crm' });
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.lastError).toContain('no hubspot credential');
    expect(crm.meetings).toHaveLength(0);
  });

  it('an unknown action is loud rather than silently skipped', async () => {
    const uid = await bookFirstSlot();
    await expect(effects.runCrmJob('nonsense', uid)).rejects.toThrow(/unknown crm action/);
  });
});

/** An ENABLED calendar provider that records every id it is handed. */
class RecordingCalendar {
  readonly enabled = true;
  readonly deleted: { externalEventId: string }[] = [];
  listBusy(): Promise<[]> {
    return Promise.resolve([]);
  }
  createEvent(): Promise<{ externalEventId: string; meetingUrl: null }> {
    return Promise.resolve({ externalEventId: 'evt-new', meetingUrl: null });
  }
  updateEvent(): Promise<{ externalEventId: string; meetingUrl: null }> {
    return Promise.resolve({ externalEventId: 'evt-new', meetingUrl: null });
  }
  deleteEvent(input: { externalEventId: string }): Promise<void> {
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

/** The OSS default calendar provider: nothing is written, nothing is enqueued. */
class DisabledCalendar {
  readonly enabled = false;
  listBusy(): Promise<[]> {
    return Promise.resolve([]);
  }
  createEvent(): Promise<never> {
    return Promise.reject(new Error('disabled'));
  }
  updateEvent(): Promise<never> {
    return Promise.reject(new Error('disabled'));
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: false, detail: 'disabled' });
  }
}
