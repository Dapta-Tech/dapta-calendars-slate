import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDb,
  createEventType,
  getAvailability,
  getTeamAvailability,
  migrate,
  seed,
  sql,
  type Db,
} from '@slate/db';
import { randomUUID } from 'node:crypto';
import {
  DisabledCalendarProvider,
  type CalendarProvider,
  type CreateEventInput,
  type CreatedEvent,
  type UpdateEventInput,
} from '@slate/calendar';
import { BookingNotifier } from '@slate/notifications';
import type { EmailMessage, EmailProvider, EmailResult } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { AdminService } from './admin.service';
import { OutboxWorker } from './outbox.worker';

class RecordingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

/** Records the event writes the outbox drains (create and move). */
class RecordingCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  readonly created: CreateEventInput[] = [];
  readonly updated: UpdateEventInput[] = [];
  private seq = 0;
  listBusy(): Promise<[]> {
    return Promise.resolve([]);
  }
  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    this.created.push(input);
    return Promise.resolve({ externalEventId: `evt-${++this.seq}` });
  }
  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    this.updated.push(input);
    return Promise.resolve({ externalEventId: input.externalEventId });
  }
  deleteEvent(): Promise<void> {
    return Promise.resolve();
  }
  listCalendars(): Promise<[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: 'Connected' });
  }
}

const ENV = loadServerEnv({
  NODE_ENV: 'test',
  PUBLIC_APP_URL: 'https://calendar.example.com/',
} as NodeJS.ProcessEnv);

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/**
 * End to end: `Reunión Felipe - {{name}}` as the calendar title and the
 * answers in the description. The booking answer, the confirmation
 * page's "Add to calendar" file and both emails' invites all read the
 * rendered text; a booking without templates answers exactly as before.
 */
describe('the calendar title and description, from the booking to the invite', () => {
  let db: Db;
  let email: RecordingEmailProvider;
  let booking: BookingService;
  let worker: OutboxWorker;
  let accountId: string;
  let memberId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    await db.run(sql`UPDATE member SET email = 'host@example.com', locale = 'es' WHERE id = ${memberId}`);
    const ev = await createEventType(db, accountId, memberId, {
      slug: 'meet',
      title: 'Reunión',
      lengthMinutes: 30,
      bookingFields: [{ name: 'company', label: 'Empresa', type: 'text', required: false }],
      calendarTitleTemplate: 'Reunión Felipe - {{name}}',
      calendarDescriptionTemplate: '{{#if form.company}}Empresa: {{form.company}}{{/if}}\nCorreo: {{email}}',
    });
    if (!ev.ok) throw new Error('event setup');

    email = new RecordingEmailProvider();
    const emailEffects = new EmailEffects(new BookingNotifier(email), db, undefined, ENV);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    booking = new BookingService(db, ENV, calendar, emailEffects);
    worker = new OutboxWorker(db, ENV, calendar, emailEffects, new DaptaSyncEffects(ENV));
  });

  async function first(slug: string): Promise<string> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots[0]!.startUtc;
  }

  const to = (m: EmailMessage) => (Array.isArray(m.to) ? m.to : [m.to]);
  const invite = (m: EmailMessage) =>
    String((m.attachments ?? [])[0]?.content ?? '').replace(/\r\n /g, '');

  it('answers with the rendered title and body, and every invite carries them', async () => {
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'meet',
      startUtc: await first('meet'),
      attendee: { name: 'Ana, López', email: 'ana@example.com', timeZone: 'America/Bogota' },
      answers: { company: 'Acme; Inc.' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.title).toBe('Reunión Felipe - Ana, López');
    expect(out.calendarDescription).toBe('Empresa: Acme; Inc.\nCorreo: ana@example.com');

    await settle();
    await worker.drainOnce(Date.now());
    const visitor = email.sent.find((m) => to(m).includes('ana@example.com'))!;
    const host = email.sent.find((m) => to(m).includes('host@example.com'))!;
    expect(visitor.subject).toContain('Reunión Felipe - Ana, López');
    for (const m of [visitor, host]) {
      expect(invite(m)).toContain('SUMMARY:Reunión Felipe - Ana\\, López\r\n');
      expect(invite(m)).toContain('DESCRIPTION:Empresa: Acme\\; Inc.\\nCorreo: ana@example.com\r\n');
    }
  });

  it('the team path answers with them too', async () => {
    const ev = await createEventType(db, accountId, null, {
      slug: 'team-meet',
      title: 'Equipo',
      lengthMinutes: 30,
      teamId: (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!.id,
      schedulingType: 'round_robin',
      hostMemberIds: [memberId],
      calendarTitleTemplate: '{{team_name}} - {{first_name}}',
      calendarDescriptionTemplate: 'Equipo {{team_name}}',
    });
    if (!ev.ok) throw new Error('team event setup');
    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-meet',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const out = await booking.teamBook('acme', 'sales', {
      slug: 'team-meet',
      startUtc: avail!.slots[0]!,
      attendee: { name: 'Sam Lee', email: 'sam@example.com', timeZone: 'UTC' },
    });
    if ('error' in out) throw new Error(`team book failed: ${out.error}`);
    expect(out).toMatchObject({ title: 'Sales - Sam', calendarDescription: 'Equipo Sales' });
  });

  it('without templates: the event name, and no description anywhere', async () => {
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startUtc: await first('intro-call'),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.title).toBe('Intro Call');
    expect('calendarDescription' in out && out.calendarDescription !== undefined).toBe(false);
    await settle();
    await worker.drainOnce(Date.now());
    for (const m of email.sent) expect(invite(m)).not.toContain('DESCRIPTION');
  });

  it('a seat taken on an existing slot rewrites its calendar event: the new guest, the shared title', async () => {
    const provider = new RecordingCalendarProvider();
    const calendar = new CalendarEffects(provider, db);
    const emailEffects = new EmailEffects(new BookingNotifier(email), db, undefined, ENV);
    const seats = new BookingService(db, ENV, calendar, emailEffects);
    const drain = new OutboxWorker(db, ENV, calendar, emailEffects, new DaptaSyncEffects(ENV));
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, 'google', 'cal-dest-1', NULL, 1, 1, ${Date.now()})`,
    );
    const startUtc = await first('meet');
    const book = async (name: string, email: string) => {
      const out = await seats.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'meet',
        startUtc,
        attendee: { name, email, timeZone: 'UTC' },
        answers: { company: `${name} Co` },
      });
      if ('error' in out) throw new Error(`book failed: ${out.error}`);
      await settle();
      await drain.drainOnce(Date.now() + 60_000);
      return out;
    };
    // Booked before the event had seats: the event is titled for Alice.
    await book('Alice Secret', 'alice@example.com');
    expect(provider.created[0]!.title).toBe('Reunión Felipe - Alice Secret');
    // Seats on, templates cleared: a save the gate allows.
    await db.run(
      sql`UPDATE event_type SET seats_per_time_slot = 5, calendar_title_template = NULL,
            calendar_description_template = NULL WHERE slug = 'meet'`,
    );
    const bob = await book('Bob Other', 'bob@example.com');
    expect(bob.title).toBe('Reunión');
    expect(provider.created).toHaveLength(1);
    expect(provider.updated).toHaveLength(1);
    expect(provider.updated[0]!).toMatchObject({ title: 'Reunión', description: '' });
    expect(provider.updated[0]!.attendeeEmails).toEqual(['host@example.com', 'alice@example.com', 'bob@example.com']);
  });

  it("the host's own booking of a seat rewrites the event once, and a repeat writes nothing", async () => {
    const provider = new RecordingCalendarProvider();
    const calendar = new CalendarEffects(provider, db);
    const emailEffects = new EmailEffects(new BookingNotifier(email), db, undefined, ENV);
    const admin = new AdminService(db, calendar, emailEffects, undefined, undefined, ENV);
    const drain = new OutboxWorker(db, ENV, calendar, emailEffects, new DaptaSyncEffects(ENV));
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, 'google', 'cal-dest-1', NULL, 1, 1, ${Date.now()})`,
    );
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 5, calendar_title_template = 'Taller' WHERE slug = 'meet'`);
    const principal = { accountId, memberId, role: 'owner' as const };
    const startUtc = await first('meet');
    const host = async (name: string, address: string) => {
      const out = await admin.hostCreate(
        principal,
        { handle: 'alex-rivera', slug: 'meet', startUtc, attendee: { name, email: address, timeZone: 'UTC' } },
        'acme',
      );
      await settle();
      await drain.drainOnce(Date.now() + 60_000);
      return out;
    };
    await host('Alice Secret', 'alice@example.com');
    await host('Bob Other', 'bob@example.com');
    expect(provider.created).toHaveLength(1);
    expect(provider.updated).toHaveLength(1);
    expect(provider.updated[0]!).toMatchObject({ title: 'Taller' });
    expect(provider.updated[0]!.attendeeEmails).toContain('bob@example.com');
    // The same seat again: nothing is even queued for the calendar.
    const calendarJobs = async () =>
      Number((await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'calendar'`))!.n);
    const queued = await calendarJobs();
    await host('Bob Other', 'bob@example.com');
    expect(await calendarJobs()).toBe(queued);
    expect(provider.created).toHaveLength(1);
    expect(provider.updated).toHaveLength(1);
  });
});
