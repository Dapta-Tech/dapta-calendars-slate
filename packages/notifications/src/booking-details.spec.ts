import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWERS,
  MAX_ANSWERS_TOTAL_CHARS,
  MAX_ANSWER_CHARS,
  MAX_ANSWER_ITEMS,
  MAX_LABEL_CHARS,
  bookingDetails,
  bookingDetailsText,
  collectBookingAnswers,
  readableAnswer,
  type BookingAnswer,
} from './booking-details';
import { BookingNotifier, hostDashboardUrl, type BookingNotification } from './booking-notifier';
import type { EmailMessage, EmailProvider, EmailResult } from './email.port';
import { resolveTemplate, type EmailTemplateKey } from './templates';

/**
 * The host's copy says who is asking and what they answered (Felipe's ask):
 * the requester, how to reach them, who else is invited, and every answer the
 * booking form took, in the host's question order and words. The request also
 * gets its one button, to the booking in the host's dashboard.
 */

describe('collectBookingAnswers', () => {
  const questions = [
    { name: 'company', label: 'Company', type: 'text' },
    { name: 'topic', label: 'What would you like to cover?', type: 'textarea' },
    { name: 'topics', label: 'Topics', type: 'select' },
    { name: 'consent', label: 'I agree to be recorded', type: 'checkbox' },
    { name: 'notes', label: 'Notes (legacy question)', type: 'textarea' },
  ];

  it("follows the event type's question order and labels, not the stored order", () => {
    const answers = collectBookingAnswers(questions, {
      consent: true,
      topics: ['Hiring', 'Budget'],
      company: 'Example Co',
      topic: 'Hiring plan',
    });
    expect(answers.map((a) => a.label)).toEqual([
      'Company',
      'What would you like to cover?',
      'Topics',
      'I agree to be recorded',
    ]);
  });

  it('drops empty answers and keeps a deliberate false', () => {
    const answers = collectBookingAnswers(questions, {
      company: '   ',
      topic: '',
      topics: [],
      consent: false,
    });
    expect(answers).toEqual([{ label: 'I agree to be recorded', value: false, type: 'checkbox' }]);
  });

  it('skips the fixed fields, which the block shows from the attendee', () => {
    const answers = collectBookingAnswers(questions, {
      notes: 'x',
      name: 'y',
      email: 'z@example.com',
    });
    expect(answers).toEqual([]);
  });

  it('lists only what the event type asks: a key no question names is not an answer', () => {
    // The public route stores `answers` as sent, so a caller could otherwise
    // put their own words in the host's mail dressed as the host's question.
    const answers = collectBookingAnswers(questions, {
      company: 'Example Co',
      'Action required: verify your payout at': 'https://evil.example/verify',
    });
    expect(answers.map((a) => [a.label, a.value])).toEqual([['Company', 'Example Co']]);
  });

  it('bounds how many answers and how long a label one message carries', () => {
    const many = Array.from({ length: MAX_ANSWERS + 5 }, (_, i) => ({
      name: `q${i}`,
      label: i === 0 ? 'L'.repeat(MAX_LABEL_CHARS + 40) : `Q${i}`,
      type: 'text',
    }));
    const answers = collectBookingAnswers(many, Object.fromEntries(many.map((q) => [q.name, 'x'])));
    expect(answers).toHaveLength(MAX_ANSWERS);
    expect(answers[0]!.label).toHaveLength(MAX_LABEL_CHARS + 1);
  });

  it('never reads inherited properties as answers', () => {
    const answers = collectBookingAnswers([{ name: 'constructor', label: 'C', type: 'text' }], {});
    expect(answers).toEqual([]);
  });

  it('cuts a very long answer and ignores shapes the form never produces', () => {
    const long = 'a'.repeat(MAX_ANSWER_CHARS + 50);
    const answers = collectBookingAnswers(questions, { company: long, topic: { nested: true } });
    expect(answers).toHaveLength(1);
    expect(String(answers[0]!.value)).toHaveLength(MAX_ANSWER_CHARS + 1);
    expect(String(answers[0]!.value).endsWith('…')).toBe(true);
  });
});

describe('the block as a whole stays bounded', () => {
  it('cuts the answers to a total, so escaping cannot push the button past a clip', () => {
    const answers = Array.from({ length: MAX_ANSWERS }, (_, i) => ({
      label: `Q${i}`,
      value: '<'.repeat(MAX_ANSWER_CHARS),
    }));
    const d = bookingDetails(
      { attendee: { name: 'Sam', email: 'sam@example.com', notes: 'n'.repeat(500) }, answers },
      'en',
    );
    const total = d.answers.reduce((sum, a) => sum + a.value.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_ANSWERS_TOTAL_CHARS + d.answers.length);
    expect(d.answers.length).toBeLessThan(MAX_ANSWERS);
  });

  it('keeps a bounded number of items in a multi-select', () => {
    const [a] = collectBookingAnswers([{ name: 'tags', label: 'Tags', type: 'select' }], {
      tags: Array.from({ length: MAX_ANSWER_ITEMS + 30 }, (_, i) => `t${i}`),
    });
    expect(a!.value).toHaveLength(MAX_ANSWER_ITEMS);
  });
});

describe('readableAnswer', () => {
  const a = (value: BookingAnswer['value'], type?: string): BookingAnswer => ({
    label: 'Q',
    value,
    type,
  });
  it('reads a box as Yes or No, in the reader language', () => {
    expect(readableAnswer(a(true), 'en')).toBe('Yes');
    expect(readableAnswer(a(false), 'es')).toBe('No');
    expect(readableAnswer(a(true), 'es')).toBe('Sí');
    // The booking page posts a checkbox question as text.
    expect(readableAnswer(a('true', 'checkbox'), 'en')).toBe('Yes');
    expect(readableAnswer(a('off', 'checkbox'), 'es')).toBe('No');
    expect(readableAnswer(a('true', 'text'), 'en')).toBe('true');
  });
  it('reads a multi-select as a list', () => {
    expect(readableAnswer(a(['Hiring', ' Budget ', '']), 'en')).toBe('Hiring, Budget');
  });
});

describe('bookingDetailsText', () => {
  it('lists who is asking, their answers and where to act', () => {
    const d = bookingDetails(
      {
        attendee: {
          name: 'Sam Guest',
          email: 'sam@example.com',
          phone: '+1 602 555 0143',
          notes: 'Line one\r\nLine two',
        },
        guests: [
          { name: 'Ana Ruiz', email: 'ana@example.com' },
          { name: 'bo@example.com', email: 'bo@example.com' },
        ],
        answers: [
          { label: 'Company', value: 'Example Co' },
          { label: 'What would you like to cover?', value: 'Hiring' },
        ],
      },
      'en',
    );
    expect(bookingDetailsText(d, 'en', 'https://app.example.com/admin/bookings#booking-x')).toBe(
      [
        'Guest details',
        'Name: Sam Guest',
        'Email: sam@example.com',
        'Phone: +1 602 555 0143',
        'Other guests: Ana Ruiz (ana@example.com), bo@example.com',
        '',
        'Their answers',
        'Company: Example Co',
        'What would you like to cover? Hiring',
        'Notes: Line one',
        '  Line two',
        '',
        'Confirm or decline: https://app.example.com/admin/bookings#booking-x',
      ].join('\n'),
    );
  });

  it('keeps a value on its own lines: a typed newline cannot start a new label', () => {
    const d = bookingDetails(
      { attendee: { name: 'Sam\nEmail: fake@example.com', email: 'sam@example.com' }, answers: [] },
      'en',
    );
    const text = bookingDetailsText(d, 'en');
    expect(text).toContain('Name: Sam Email: fake@example.com');
    expect(text.split('\n').filter((l) => l.startsWith('Email:'))).toEqual([
      'Email: sam@example.com',
    ]);
  });

  it('says nothing about answers when there are none, and in Spanish speaks Spanish', () => {
    const d = bookingDetails({ attendee: { name: 'Sam', email: 'sam@example.com' } }, 'es');
    expect(bookingDetailsText(d, 'es')).toBe(
      ['Datos del invitado', 'Nombre: Sam', 'Correo: sam@example.com'].join('\n'),
    );
  });
});

class Recorder implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const DASHBOARD = 'https://app.example.com/admin/bookings#booking-bk-1';
const base: BookingNotification = {
  accountId: '11111111-1111-4111-8111-111111111111',
  uid: 'bk-1',
  title: 'An interview',
  startUtc: '2026-10-20T19:00:00.000Z',
  endUtc: '2026-10-20T19:30:00.000Z',
  host: { name: 'Felipe Host', email: 'host@example.com', timeZone: 'America/Bogota' },
  attendee: {
    name: 'Test Visitor',
    email: 'visitor@example.com',
    timeZone: 'America/Phoenix',
    phone: '+1 602 555 0143',
    notes: 'Joining from my phone',
  },
  guests: [{ name: 'Ana Ruiz', email: 'ana@example.com' }],
  answers: [{ label: 'Company', value: 'Example Co', type: 'text' }],
  dashboardUrl: DASHBOARD,
  location: 'Online meeting',
  locationKind: 'conferencing',
  manageUrl: 'https://app.example.com/manage/bk-1?token=tok',
  stamp: '2026-10-15T12:00:00.000Z',
};

type Kind = 'pending' | 'confirmation' | 'reschedule' | 'cancellation' | 'declined' | 'reminder';
const HOST_KEY: Record<Kind, EmailTemplateKey> = {
  pending: 'host_booked',
  confirmation: 'host_booked',
  reschedule: 'host_rescheduled',
  cancellation: 'host_cancelled',
  declined: 'host_declined',
  reminder: 'host_reminder',
};
const INVITEE_KEY: Record<Kind, EmailTemplateKey> = {
  pending: 'attendee_pending',
  confirmation: 'attendee_confirmation',
  reschedule: 'attendee_reschedule',
  cancellation: 'attendee_cancellation',
  declined: 'attendee_declined',
  reminder: 'attendee_reminder',
};

async function send(
  kind: Kind,
  audience: 'attendee' | 'host',
  over: Partial<BookingNotification> = {},
  locale: 'en' | 'es' = 'en',
  withTemplate = true,
): Promise<EmailMessage> {
  const rec = new Recorder();
  const notifier = new BookingNotifier(rec);
  const key = audience === 'host' ? HOST_KEY[kind] : INVITEE_KEY[kind];
  const n: BookingNotification & { reminderLeadMinutes?: number } = {
    ...base,
    audience,
    templateLocale: locale,
    template: withTemplate ? resolveTemplate(key, null, locale) : null,
    pending: kind === 'pending',
    reminderLeadMinutes: 60,
    ...over,
  };
  if (kind === 'pending') await notifier.sendPendingRequest(n);
  if (kind === 'confirmation') await notifier.sendConfirmation(n);
  if (kind === 'reschedule')
    await notifier.sendReschedule({ ...n, previousStartUtc: '2026-10-19T19:00:00.000Z' });
  if (kind === 'cancellation') await notifier.sendCancellation(n);
  if (kind === 'declined') await notifier.sendDeclined(n);
  if (kind === 'reminder') await notifier.sendReminder(n);
  return rec.sent[0]!;
}

describe("the host's copy says who is asking and what they answered", () => {
  it('the request: the person, the other guests, every answer, and the dashboard button', async () => {
    for (const locale of ['en', 'es'] as const) {
      const m = await send('pending', 'host', {}, locale);
      for (const part of [String(m.text), String(m.html)]) {
        expect(part, locale).toContain('Test Visitor');
        expect(part, locale).toContain('visitor@example.com');
        expect(part, locale).toContain('+1 602 555 0143');
        expect(part, locale).toContain('Ana Ruiz (ana@example.com)');
        expect(part, locale).toContain('Company');
        expect(part, locale).toContain('Example Co');
        expect(part, locale).toContain('Joining from my phone');
        expect(part, locale).toContain(DASHBOARD);
      }
      // One button, and it is the dashboard, labelled for what it does.
      expect(m.html).toContain(`href="${DASHBOARD}"`);
      expect(m.html).toContain(locale === 'es' ? 'Confirmar o rechazar' : 'Confirm or decline');
      expect(String(m.html).match(/<a href=/g)).toHaveLength(1);
    }
  });

  it('the confirmed booking and the move carry the block, with no button', async () => {
    for (const kind of ['confirmation', 'reschedule'] as const) {
      const m = await send(kind, 'host');
      expect(m.text, kind).toContain('Their answers\nCompany: Example Co');
      expect(m.html, kind).toContain('Example Co');
      expect(m.html, kind).not.toContain(DASHBOARD);
      expect(m.text, kind).not.toContain(DASHBOARD);
    }
  });

  it('a host who edited the template still gets the block', async () => {
    const m = await send('pending', 'host', {
      template: { subject: 'Request', body: 'Someone asked.' },
    });
    expect(m.text).toContain('Someone asked.\n\nGuest details\nName: Test Visitor');
    expect(m.text).toContain(`Confirm or decline: ${DASHBOARD}`);
  });

  it('so does a copy rendered without any template (the legacy path)', async () => {
    const m = await send('pending', 'host', {}, 'en', false);
    expect(m.text).toContain('Their answers\nCompany: Example Co');
  });

  it('cancellations, declines and reminders do not repeat it', async () => {
    for (const kind of ['cancellation', 'declined', 'reminder'] as const) {
      const m = await send(kind, 'host');
      expect(`${m.text}\n${m.html}`, kind).not.toContain('Example Co');
      expect(`${m.text}\n${m.html}`, kind).not.toContain(DASHBOARD);
    }
  });

  it("no invitee copy carries the host's view: no answers, guests, phone, notes or dashboard", async () => {
    for (const kind of Object.keys(INVITEE_KEY) as Kind[]) {
      for (const withTemplate of [true, false]) {
        const m = await send(kind, 'attendee', {}, 'en', withTemplate);
        const all = `${m.subject}\n${m.text}\n${m.html}`;
        for (const secret of [
          'Example Co',
          'ana@example.com',
          '+1 602 555 0143',
          'Joining from my phone',
          DASHBOARD,
        ]) {
          expect(all, `${kind} ${withTemplate} ${secret}`).not.toContain(secret);
        }
      }
    }
  });

  it('a request without a dashboard link (an old row, a fork) keeps the old words and no button', async () => {
    const m = await send('pending', 'host', { dashboardUrl: null });
    expect(m.html).toContain('Confirm or decline it from your bookings.');
    expect(m.html).not.toContain('Confirm or decline</a>');
    expect(m.text).not.toContain('Confirm or decline:');
  });

  it('only an http(s) link becomes the button', () => {
    expect(hostDashboardUrl({ audience: 'host', dashboardUrl: 'javascript:alert(1)' })).toBe('');
    expect(hostDashboardUrl({ audience: 'host', dashboardUrl: 'https://x.example/a b' })).toBe('');
    expect(hostDashboardUrl({ audience: 'attendee', dashboardUrl: DASHBOARD })).toBe('');
    expect(hostDashboardUrl({ audience: 'host', dashboardUrl: DASHBOARD })).toBe(DASHBOARD);
  });
});

describe('visitor input cannot inject anything', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  it('every answer, label, name and guest is escaped in the HTML', async () => {
    const m = await send('pending', 'host', {
      attendee: { ...base.attendee, name: evil, phone: evil, notes: evil },
      guests: [{ name: evil, email: 'g@example.com' }],
      answers: [{ label: evil, value: [evil, evil] }],
    });
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a line break in a title or a name never reaches the subject header', async () => {
    const legacy = await send(
      'pending',
      'host',
      { title: 'Call\r\nBcc: victim@example.com' },
      'en',
      false,
    );
    expect(legacy.subject).not.toMatch(/[\r\n]/);
    const custom = await send('pending', 'host', {
      attendee: { ...base.attendee, name: 'Sam\r\nBcc: victim@example.com' },
      template: { subject: 'Request from {{attendee_name}}', body: 'x' },
    });
    expect(custom.subject).not.toMatch(/[\r\n]/);
  });
});

describe('the support line follows the deployment (F10)', () => {
  async function footer(supportEmail?: string | null): Promise<string> {
    const rec = new Recorder();
    await new BookingNotifier(
      rec,
      supportEmail === undefined ? {} : { supportEmail },
    ).sendConfirmation({
      ...base,
      audience: 'attendee',
      template: resolveTemplate('attendee_confirmation', null, 'en'),
    });
    return String(rec.sent[0]!.html);
  }

  it('is absent unless the deployment names an address', async () => {
    expect(await footer()).not.toMatch(/Need help\?|mailto:/);
    expect(await footer(null)).not.toMatch(/Need help\?|mailto:/);
  });

  it('names the configured address', async () => {
    const html = await footer('help@example.com');
    expect(html).toContain('Need help? <a href="mailto:help@example.com"');
  });

  it('drops anything that is not a bare address', async () => {
    for (const bad of [
      'help@example.com?bcc=x@example.com',
      'not an address',
      'a@b',
      '"><script>@x.com',
    ]) {
      expect(await footer(bad), bad).not.toMatch(/Need help\?|mailto:/);
    }
  });
});
