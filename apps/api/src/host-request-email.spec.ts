import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDb,
  createEventType,
  getAvailability,
  getTeamAvailability,
  listOutbox,
  migrate,
  seed,
  sql,
  upsertNotificationSetting,
  type Db,
} from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier, type BookingNotification } from '@slate/notifications';
import type { EmailMessage, EmailProvider, EmailResult } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { CalendarEffects } from './calendar-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import { OutboxWorker } from './outbox.worker';

class RecordingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
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
 * The real case from the field: a request on an event the host confirms by
 * hand, host in America/Bogota, visitor in America/Phoenix. The host's mail
 * must say who is asking and what they answered, offer the dashboard to act
 * from, and be written in the host's zone and language; the visitor's must be
 * in the language they booked in (F6) and carry none of the host's view.
 */
describe("the host's request email, end to end through the outbox", () => {
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
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle='alex-rivera'`,
    ))!.id;
    await db.run(
      sql`UPDATE member SET email = 'host@example.com', time_zone = 'America/Bogota', locale = 'en'
          WHERE id = ${memberId}`,
    );
    const ev = await createEventType(db, accountId, memberId, {
      slug: 'interview',
      title: 'An interview with Felipe',
      lengthMinutes: 30,
      requiresConfirmation: true,
      scheduleId: null,
      bookingFields: [
        {
          name: 'topics',
          label: 'Which topics?',
          type: 'select',
          required: false,
          options: ['Hiring', 'Budget'],
        },
        { name: 'company', label: 'Company', type: 'text', required: true },
        { name: 'recording', label: 'I agree to be recorded', type: 'checkbox', required: false },
        { name: 'phone', label: 'Best number', type: 'phone', required: false },
        { name: 'skipped', label: 'Anything else?', type: 'textarea', required: false },
      ],
    });
    if (!ev.ok) throw new Error('event setup');

    email = new RecordingEmailProvider();
    const emailEffects = new EmailEffects(new BookingNotifier(email), db, undefined, ENV);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    booking = new BookingService(db, ENV, calendar, emailEffects);
    worker = new OutboxWorker(db, ENV, calendar, emailEffects, new DaptaSyncEffects(ENV));
  });

  /** The first `n` times the event offers, as the page would book them. */
  async function times(slug: string): Promise<string[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots.map((s) => s.startUtc);
  }

  /**
   * A request, as the booking page sends it: the page's language as `locale`.
   * `language` stands for an API caller's explicit `attendee.language`.
   */
  async function request(
    opts: { locale?: 'en' | 'es'; language?: 'en' | 'es' } = {},
  ): Promise<string> {
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'interview',
      startUtc: (await times('interview'))[0]!,
      attendee: {
        name: 'Test Visitor',
        email: 'visitor@example.com',
        timeZone: 'America/Phoenix',
        notes: 'I will join from my phone.',
        ...(opts.language ? { language: opts.language } : {}),
      },
      ...(opts.locale ? { locale: opts.locale } : {}),
      // Stored in a different order than the host asked the questions, plus a
      // key no question names, which must not reach the host's mail.
      answers: {
        recording: true,
        company: 'Example Co',
        topics: ['Hiring', 'Budget'],
        skipped: '',
        phone: '+1 602 555 0143',
        'Action required: verify your payout at': 'https://evil.example/verify',
      },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.status).toBe('pending');
    await settle();
    await worker.drainOnce(Date.now());
    return out.uid;
  }

  const to = (m: EmailMessage) => (Array.isArray(m.to) ? m.to : [m.to]);
  const hostMail = () => email.sent.find((m) => to(m).includes('host@example.com'))!;
  const visitorMail = () => email.sent.find((m) => to(m).includes('visitor@example.com'))!;

  it('tells the host who is asking, every answer in question order, and where to act', async () => {
    const uid = await request({ locale: 'es' });
    const m = hostMail();
    expect(m.subject).toMatch(/^New booking: An interview with Felipe/);
    // The host reads the time on the host's clock (#214), in the host's language.
    expect(m.text).toMatch(/When: .*GMT-5/);
    const text = String(m.text);
    expect(text).toContain(
      [
        'Guest details',
        'Name: Test Visitor',
        'Email: visitor@example.com',
        '',
        'Their answers',
        'Which topics? Hiring, Budget',
        'Company: Example Co',
        'I agree to be recorded: Yes',
        'Best number: +1 602 555 0143',
        'Notes: I will join from my phone.',
      ].join('\n'),
    );
    expect(text).not.toContain('Anything else?');
    expect(`${text}\n${m.html}`).not.toContain('evil.example');
    const dashboard = `https://calendar.example.com/admin/bookings#booking-${uid}`;
    expect(text).toContain(`Confirm or decline: ${dashboard}`);
    expect(m.html).toContain(`href="${dashboard}"`);
  });

  it("writes the visitor's copy in the language they booked in, without the host's view", async () => {
    await request({ locale: 'es' });
    const m = visitorMail();
    expect(m.subject).toMatch(/^Solicitud recibida: /);
    expect(m.html).toContain('Pendiente');
    // On the visitor's own clock: Phoenix keeps MST all year.
    expect(m.text).toMatch(/Cuándo: .*(MST|GMT-7)/);
    for (const secret of [
      'Example Co',
      '+1 602 555 0143',
      'admin/bookings',
      'I will join from my phone.',
    ]) {
      expect(`${m.text}\n${m.html}`, secret).not.toContain(secret);
    }
    // The host's copy keeps the host's language.
    expect(hostMail().subject).toMatch(/^New booking: /);
  });

  it('a booking with no recorded language keeps the visitor copy in the host language, as before', async () => {
    await db.run(sql`UPDATE member SET locale = 'es' WHERE id = ${memberId}`);
    await request();
    expect(visitorMail().subject).toMatch(/^Solicitud recibida: /);
    expect(hostMail().subject).toMatch(/^Nueva reserva: /);
  });

  it('an English visitor on a Spanish host page gets English mail; the host keeps Spanish', async () => {
    await db.run(sql`UPDATE member SET locale = 'es' WHERE id = ${memberId}`);
    await request({ locale: 'en' });
    expect(visitorMail().subject).toMatch(/^Request received: /);
    expect(hostMail().subject).toMatch(/^Nueva reserva: /);
    expect(hostMail().text).toContain('Sus respuestas\nWhich topics? Hiring, Budget');
  });

  it("snapshots the host's view on the host's row only", async () => {
    await request({ locale: 'es' });
    const rows = (await listOutbox(db, { kind: 'email' })).filter((r) => r.action === 'pending');
    const payloads = rows.map((r) => JSON.parse(r.payload ?? '{}') as BookingNotification);
    const host = payloads.find((p) => p.audience === 'host')!;
    const visitor = payloads.find((p) => p.audience === 'attendee')!;
    expect(host.answers?.map((a) => a.label)).toEqual([
      'Which topics?',
      'Company',
      'I agree to be recorded',
      'Best number',
    ]);
    expect(host.dashboardUrl).toMatch(
      /^https:\/\/calendar\.example\.com\/admin\/bookings#booking-/,
    );
    expect(host.templateLocale).toBe('en');
    expect(visitor.templateLocale).toBe('es');
    expect(visitor.answers).toBeUndefined();
    expect(visitor.guests).toBeUndefined();
    expect(visitor.dashboardUrl).toBeUndefined();
    expect(visitor.attendee).not.toHaveProperty('notes');
  });

  it("an API caller's explicit attendee.language decides, and wins over the page's", async () => {
    await request({ language: 'es', locale: 'en' });
    expect(visitorMail().subject).toMatch(/^Solicitud recibida: /);
  });

  it("the page's language is the booking's, never the contact's (the CRM reads that one)", async () => {
    const uid = await request({ locale: 'es' });
    const row = await db.get<{ locale: string | null; language: string | null }>(
      sql`SELECT b.locale, a.language FROM booking b
          JOIN booking_attendee a ON a.booking_id = b.id WHERE b.uid = ${uid}`,
    );
    expect(row).toEqual({ locale: 'es', language: null });
  });

  it("copy the host wrote keeps the host's language whole, as before", async () => {
    // One language per custom text: the host's. A Spanish frame around an
    // English custom subject would mix the two.
    await upsertNotificationSetting(db, accountId, 'attendee_pending', {
      subject: 'We got your request for {{event_title}}',
    });
    await request({ locale: 'es' });
    const m = visitorMail();
    expect(m.subject).toBe('We got your request for An interview with Felipe');
    expect(m.text).toMatch(/^Hi Test Visitor,/);
    expect(m.html).toContain('Pending');
  });

  it("the team page's language is the booking's too, and only en or es is kept", async () => {
    const team = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const stored: Array<{ locale: string | null; language: string | null }> = [];
    for (const [i, locale] of ['es', 'fr'].entries()) {
      // The team route forwards its body as it arrived: `locale` is unvalidated.
      const out = await booking.teamBook('acme', 'sales', {
        slug: 'team-demo',
        startUtc: team!.slots[i]!,
        attendee: { name: 'Team Visitor', email: `team-${i}@example.com`, timeZone: 'UTC' },
        locale,
      });
      if ('error' in out) throw new Error(`team book failed: ${out.error}`);
      stored.push(
        (await db.get<{ locale: string | null; language: string | null }>(
          sql`SELECT b.locale, a.language FROM booking b
              JOIN booking_attendee a ON a.booking_id = b.id WHERE b.uid = ${out.uid}`,
        ))!,
      );
    }
    expect(stored).toEqual([
      { locale: 'es', language: null },
      { locale: null, language: null },
    ]);
  });

  it('the confirmed booking and the move carry the block too, with no button', async () => {
    await db.run(sql`UPDATE event_type SET requires_confirmation = 0 WHERE slug = 'interview'`);
    const [first, second] = await times('interview');
    const out = await booking.book({
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'interview',
      startUtc: first!,
      attendee: { name: 'Test Visitor', email: 'visitor@example.com', timeZone: 'America/Phoenix' },
      locale: 'es',
      answers: { company: 'Example Co' },
    });
    if ('error' in out) throw new Error(`book failed: ${out.error}`);
    expect(out.status).toBe('accepted');
    const token = new URL(out.manageUrl!).searchParams.get('token')!;
    const moved = await booking.reschedule(out.uid, { newStartUtc: second!, token });
    if ('error' in moved) throw new Error(`reschedule failed: ${moved.error}`);
    await settle();
    await worker.drainOnce(Date.now());
    const hostCopies = email.sent.filter((m) => to(m).includes('host@example.com'));
    const confirmed = hostCopies.find((m) => m.subject.startsWith('New booking:'))!;
    const rescheduled = hostCopies.find((m) => m.subject.startsWith('Rescheduled:'))!;
    for (const m of [confirmed, rescheduled]) {
      expect(m.text, m.subject).toContain('Their answers\nCompany: Example Co');
      expect(m.html, m.subject).not.toContain('admin/bookings');
    }
    // The visitor's own copies, in Spanish, and without the host's view.
    const visitorCopies = email.sent.filter((m) => to(m).includes('visitor@example.com'));
    expect(visitorCopies.map((m) => m.subject.split(':')[0]).sort()).toEqual(['Confirmada', 'Reprogramada']);
    for (const m of visitorCopies) expect(m.text, m.subject).not.toContain('Example Co');
  });
});
