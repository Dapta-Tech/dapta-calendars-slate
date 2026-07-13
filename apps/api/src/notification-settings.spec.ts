import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDb,
  migrate,
  seed,
  sql,
  getAvailability,
  listOutbox,
  upsertNotificationSetting,
  type Db,
} from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { BookingNotifier } from '@slate/notifications';
import type { EmailMessage, EmailProvider, EmailResult } from '@slate/notifications';
import { loadServerEnv } from '@slate/config/env';
import { AdminService } from './admin.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';
import { BookingService } from './booking.service';
import type { HostPrincipal } from './auth.service';

class RecordingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(m: EmailMessage): Promise<EmailResult> {
    this.sent.push(m);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Settings → Notifications wire-through: per-side toggles gate the outbox at
 * ENQUEUE time, custom templates render into the delivered mail, and queued
 * reminders are re-gated at DELIVER time.
 */
describe('notification settings — toggles + templates through the outbox', () => {
  let db: Db;
  let email: RecordingEmailProvider;
  let booking: BookingService;
  let effects: EmailEffects;
  let admin: AdminService;
  let accountId: string;
  let principal: HostPrincipal;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const member = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    await db.run(sql`UPDATE member SET email='alex@dapta.test', role='owner' WHERE id=${member.id}`);
    accountId = member.account_id;
    principal = { accountId, memberId: member.id, role: 'owner' };
    email = new RecordingEmailProvider();
    effects = new EmailEffects(new BookingNotifier(email), db);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    booking = new BookingService(db, ENV, calendar, effects);
    admin = new AdminService(db, calendar, effects);
  });

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
    return out.uid;
  }

  const emailRows = async (uid: string, action: string) =>
    (await listOutbox(db, { kind: 'email', bookingUid: uid })).filter((r) => r.action === action);

  it('booking enqueues one confirmation row per side with resolved templates', async () => {
    const uid = await book();
    await settle();
    const rows = await emailRows(uid, 'confirmation');
    expect(rows).toHaveLength(2);
    const payloads = rows.map((r) => JSON.parse(r.payload!) as { audience: string; template?: { subject: string } });
    expect(payloads.map((p) => p.audience).sort()).toEqual(['attendee', 'host']);
    for (const p of payloads) expect(p.template?.subject).toBeTruthy();
  });

  it('a disabled side is NOT enqueued (no misleading delivery-log rows)', async () => {
    await upsertNotificationSetting(db, accountId, 'host_booked', { enabled: false });
    const uid = await book();
    await settle();
    const rows = await emailRows(uid, 'confirmation');
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0]!.payload!) as { audience: string }).audience).toBe('attendee');
  });

  it('a custom template renders into the delivered mail (variables + escaping)', async () => {
    await upsertNotificationSetting(db, accountId, 'attendee_confirmation', {
      subject: 'See you, {{attendee_name}}!',
      body: 'Booked <b>{{event_title}}</b> — {{start_time}}',
    });
    const uid = await book();
    await settle();
    const row = (await emailRows(uid, 'confirmation')).find(
      (r) => (JSON.parse(r.payload!) as { audience: string }).audience === 'attendee',
    )!;
    await effects.deliver('confirmation', row.payload!, row.accountId);
    const m = email.sent.at(-1)!;
    expect(m.subject).toBe('See you, Sam!');
    expect(m.text).toContain('Booked <b>Intro Call</b>');
    expect(m.html).toContain('&lt;b&gt;Intro Call&lt;/b&gt;'); // template markup escaped
    expect(m.to).toEqual(['sam@example.com']); // attendee side only
  });

  it('reminder leads come from settings; disabled reminder side is not scheduled', async () => {
    await upsertNotificationSetting(db, accountId, 'attendee_reminder', { reminderLeadMinutes: [120] });
    await upsertNotificationSetting(db, accountId, 'host_reminder', { enabled: false });
    const uid = await book();
    await settle();
    const rows = await emailRows(uid, 'reminder');
    expect(rows).toHaveLength(1); // one lead × attendee side only
    const p = JSON.parse(rows[0]!.payload!) as { audience: string; reminderLeadMinutes: number };
    expect(p.audience).toBe('attendee');
    expect(p.reminderLeadMinutes).toBe(120);
  });

  it('a queued reminder is re-gated at deliver time (toggle OFF after scheduling)', async () => {
    const uid = await book();
    await settle();
    const row = (await emailRows(uid, 'reminder')).find(
      (r) => (JSON.parse(r.payload!) as { audience?: string }).audience === 'attendee',
    )!;
    // Flip OFF after the row was scheduled — delivery must silently skip.
    await upsertNotificationSetting(db, accountId, 'attendee_reminder', { enabled: false });
    await effects.deliver('reminder', row.payload!, row.accountId);
    expect(email.sent.filter((m) => m.subject.startsWith('Reminder:'))).toHaveLength(0);
  });

  it('declined has no host side', async () => {
    // Direct enqueue: decline fans out to the attendee only.
    const uid = await book();
    await settle();
    await effects.enqueueDeclined(uid, { reason: 'nope' });
    const rows = await emailRows(uid, 'declined');
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0]!.payload!) as { audience: string }).audience).toBe('attendee');
  });

  it('listNotificationSettings returns the full catalog with defaults + overrides', async () => {
    await upsertNotificationSetting(db, accountId, 'attendee_cancellation', {
      enabled: false,
      subject: 'Bye',
    });
    const out = await admin.listNotificationSettings(principal);
    expect(out.settings).toHaveLength(10);
    expect(out.variables).toContain('attendee_name');
    const cancel = out.settings.find((s) => s.key === 'attendee_cancellation')!;
    expect(cancel.enabled).toBe(false);
    expect(cancel.subject).toBe('Bye');
    expect(cancel.customized).toBe(true);
    expect(cancel.defaultSubject).toContain('Cancelled:');
    const conf = out.settings.find((s) => s.key === 'attendee_confirmation')!;
    expect(conf.enabled).toBe(true);
    expect(conf.customized).toBe(false);
    const rem = out.settings.find((s) => s.key === 'attendee_reminder')!;
    expect(rem.reminderLeadMinutes).toEqual([1440, 60]);
  });

  it('preview renders sample data and flags unknown tokens; reset restores defaults', async () => {
    const preview = await admin.previewNotificationTemplate(principal, 'attendee_confirmation', {
      subject: 'Yo {{attendee_name}} {{bogus_token}}',
      body: null,
    });
    expect(preview.subject).toMatch(/^Yo /);
    expect(preview.unknownTokens).toEqual(['bogus_token']);
    expect(preview.text.length).toBeGreaterThan(0);

    await upsertNotificationSetting(db, accountId, 'attendee_confirmation', { subject: 'X', body: 'Y' });
    const reset = await admin.resetNotificationTemplate(principal, 'attendee_confirmation');
    expect(reset.subject).toBeNull();
    expect(reset.body).toBeNull();
  });
});
