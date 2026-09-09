import { describe, it, expect, beforeEach } from 'vitest';
import { BookingNotifier, type BookingNotification } from './booking-notifier';
import type { EmailMessage, EmailProvider, EmailResult } from './email.port';
import {
  DEFAULT_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  defaultTemplate,
  extractTokens,
  renderTemplate,
  resolveTemplate,
  templateVars,
  unknownTokens,
} from './templates';

class RecordingEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const base: BookingNotification = {
  accountId: '11111111-1111-4111-8111-111111111111',
  uid: 'bk-123',
  title: 'Intro Call',
  startUtc: '2026-08-01T15:00:00.000Z',
  endUtc: '2026-08-01T15:30:00.000Z',
  host: { name: 'Alex Rivera', email: 'alex@example.com' },
  coHosts: [{ name: 'Jordan', email: 'jordan@example.com' }],
  attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/New_York' },
  location: 'Online meeting',
  manageUrl: 'https://app.example.com/manage/bk-123?token=tok',
  stamp: '2026-07-09T12:00:00.000Z',
};

describe('{{form.*}} — the per-event intake namespace', () => {
  const withAnswers = (answers: Record<string, unknown>): BookingNotification => ({
    ...base,
    formAnswers: answers,
  });

  it('renders a string answer, and a multi-select as a comma list', () => {
    const r = renderTemplate(
      { subject: 'Re: {{form.topic}}', body: 'Topic: {{form.topic}}\nTools: {{form.tools}}' },
      templateVars(withAnswers({ topic: 'Pricing', tools: ['Forms', 'Calendars'] })),
    );
    expect(r.subject).toBe('Re: Pricing');
    expect(r.text).toContain('Topic: Pricing');
    expect(r.text).toContain('Tools: Forms, Calendars');
  });

  it('renders a boolean in the template locale, not as true/false', () => {
    expect(
      renderTemplate({ subject: 's', body: 'First time: {{form.newbie}}' }, templateVars(withAnswers({ newbie: true })))
        .text,
    ).toBe('First time: Yes');
    expect(
      renderTemplate(
        { subject: 's', body: 'Primera vez: {{form.newbie}}' },
        templateVars(withAnswers({ newbie: true }), 'es'),
      ).text,
    ).toBe('Primera vez: Sí');
  });

  it('an unanswered or deleted question renders empty and drops its line', () => {
    // #68 decision 3: a dangling reference warns on save, it does not break mail.
    const r = renderTemplate(
      { subject: 'Hi {{attendee_name}}', body: 'Kept line\nBudget: {{form.budget}}' },
      templateVars(withAnswers({ topic: 'Pricing' })),
    );
    expect(r.text).toBe('Kept line');
    expect(r.text).not.toContain('{{');
  });

  it('a question cannot shadow a built-in — the prefix keeps them apart', () => {
    const r = renderTemplate(
      { subject: 's', body: 'Where: {{location}}\nAsked: {{form.location}}' },
      templateVars(withAnswers({ location: 'Their office' })),
    );
    expect(r.text).toContain('Where: Online meeting'); // the booking's own Where
    expect(r.text).toContain('Asked: Their office'); // the intake answer
  });

  it('prototype keys stay inert — they never stringify a function', () => {
    // The literal answer key is `form.__proto__`, so nothing reaches
    // Object.prototype; both tokens resolve empty. `{{attendee_name}}` keeps
    // the line alive so the assertion sees the substitution, not the drop.
    const r = renderTemplate(
      { subject: 's', body: 'A{{form.__proto__}}B{{form.constructor}}C {{attendee_name}}' },
      templateVars(withAnswers({ safe: 'x' })),
    );
    expect(r.text).toBe('ABC Sam Guest');
  });

  it('unknownTokens counts a form variable as known only for THIS event’s fields', () => {
    const text = 'Hi {{attendee_name}} — {{form.topic}} {{form.gone}} {{bogus}}';
    expect(unknownTokens(text, ['topic'])).toEqual(['form.gone', 'bogus']);
    // With no event in hand (the account-wide preview) every form token is unknown.
    expect(unknownTokens(text)).toEqual(['form.topic', 'form.gone', 'bogus']);
  });
});

describe('renderTemplate — safety and substitution', () => {
  it('substitutes whitelisted variables in subject and body', () => {
    const r = renderTemplate(
      { subject: 'Hello {{attendee_name}}', body: 'Booked "{{event_title}}" at {{start_time}}' },
      templateVars(base),
    );
    expect(r.subject).toBe('Hello Sam Guest');
    expect(r.text).toContain('Booked "Intro Call" at Sat, Aug 1');
  });

  it('escapes HTML in template text AND substituted values (no injection)', () => {
    const evil = {
      ...base,
      title: '<script>alert(1)</script>',
      attendee: { ...base.attendee, name: '<img src=x onerror=1>' },
    };
    const r = renderTemplate(
      { subject: '{{event_title}}', body: '<b>Hi</b> {{attendee_name}} — {{event_title}}' },
      templateVars(evil),
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img');
    expect(r.html).not.toContain('<b>'); // template-authored markup is escaped too
    expect(r.html).toContain('&lt;script&gt;');
    // Plain-text part keeps raw values (no HTML context).
    expect(r.text).toContain('<script>alert(1)</script>');
  });

  it('{{constructor}}/{{__proto__}} resolve EMPTY — no prototype lookup leaks', () => {
    const vars = templateVars(base);
    const r = renderTemplate(
      {
        subject: 'S {{constructor}}{{__proto__}}{{has_own_property}}',
        body: 'Line: {{constructor}}\nKeep: {{attendee_name}} {{__proto__}}',
      },
      vars,
    );
    expect(r.subject).toBe('S');
    // A line whose only tokens are prototype names counts as all-empty → dropped.
    expect(r.text).not.toContain('Line:');
    expect(r.text).toContain('Keep: Sam Guest');
    expect(r.text).not.toMatch(/function|object Object/i);
    expect(r.html).not.toMatch(/function|object Object/i);
  });

  it('unknown tokens resolve empty and are reported by unknownTokens()', () => {
    const r = renderTemplate(
      { subject: 'x {{nope}}', body: 'Hi {{attendee_name}} {{also_nope}} end' },
      templateVars(base),
    );
    expect(r.subject).toBe('x');
    expect(r.text).toContain('Hi Sam Guest  end');
    expect(unknownTokens('x {{nope}} {{attendee_name}}')).toEqual(['nope']);
    expect(extractTokens('{{a_b}} {{ c_d }}')).toEqual(['a_b', 'c_d']);
  });

  it('drops lines whose tokens all resolve empty (optional fields)', () => {
    const noLocation = { ...base, location: null, manageUrl: null };
    const r = renderTemplate(defaultTemplate('attendee_confirmation'), templateVars(noLocation));
    expect(r.text).not.toContain('Where:');
    expect(r.text).not.toContain('Manage your booking');
    expect(r.text).toContain('Host: Alex Rivera'); // still resolves
  });

  it('{{pending_note}} appears only for pending bookings', () => {
    const confirmed = renderTemplate(defaultTemplate('host_booked'), templateVars(base));
    expect(confirmed.text).not.toContain('pending your confirmation');
    const pending = renderTemplate(
      defaultTemplate('host_booked'),
      templateVars({ ...base, pending: true }),
    );
    expect(pending.text).toContain('This request is pending your confirmation.');
  });

  it('ships EN and ES defaults for every catalog key', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const locale of ['en', 'es'] as const) {
        const t = DEFAULT_TEMPLATES[locale][key];
        expect(t.subject.length, `${locale}/${key} subject`).toBeGreaterThan(0);
        expect(t.body.length, `${locale}/${key} body`).toBeGreaterThan(0);
        expect(unknownTokens(t.subject + '\n' + t.body), `${locale}/${key} tokens`).toEqual([]);
      }
    }
    expect(defaultTemplate('attendee_confirmation', 'es').subject).toContain('Confirmada');
    expect(defaultTemplate('attendee_confirmation', null).subject).toContain('Confirmed');
  });

  it('resolveTemplate mixes per-field overrides with the default', () => {
    const t = resolveTemplate('attendee_confirmation', { subject: 'Custom!', body: null });
    expect(t.subject).toBe('Custom!');
    expect(t.body).toBe(defaultTemplate('attendee_confirmation').body);
  });
});

describe('BookingNotifier — audience + template rendering', () => {
  let email: RecordingEmailProvider;
  let notifier: BookingNotifier;
  beforeEach(() => {
    email = new RecordingEmailProvider();
    notifier = new BookingNotifier(email);
  });
  const recipients = (m: EmailMessage) => (Array.isArray(m.to) ? [...m.to].sort() : [m.to]);

  it('audience=attendee sends to the attendee only, legacy idempotency key', async () => {
    await notifier.sendConfirmation({
      ...base,
      audience: 'attendee',
      template: defaultTemplate('attendee_confirmation'),
    });
    const m = email.sent[0]!;
    expect(recipients(m)).toEqual(['sam@example.com']);
    expect(m.idempotencyKey).toBe('calendar:bk-123:confirmation');
    expect(m.subject).toMatch(/^Confirmed: Intro Call/);
  });

  it('audience=host sends to host + co-hosts with a :host key and host copy', async () => {
    await notifier.sendConfirmation({
      ...base,
      audience: 'host',
      template: defaultTemplate('host_booked'),
    });
    const m = email.sent[0]!;
    expect(recipients(m)).toEqual(['alex@example.com', 'jordan@example.com']);
    expect(m.idempotencyKey).toBe('calendar:bk-123:confirmation:host');
    expect(m.subject).toMatch(/^New booking: Intro Call/);
    expect(m.text).toContain('Sam Guest (sam@example.com) booked "Intro Call"');
    // Host copy still ships the invite .ics.
    expect(String(m.attachments?.[0]?.content ?? '')).toContain('METHOD:REQUEST');
  });

  it('custom template overrides the copy; ES locale formats variables', async () => {
    await notifier.sendCancellation({
      ...base,
      audience: 'attendee',
      cancellationReason: 'Sick',
      template: { subject: 'Adiós {{attendee_name}}', body: 'Motivo: {{cancellation_reason}}' },
      templateLocale: 'es',
    });
    const m = email.sent[0]!;
    expect(m.subject).toBe('Adiós Sam Guest');
    expect(m.text).toBe('Motivo: Sick');
  });

  it('reminder templates get {{reminder_lead}} from the payload lead', async () => {
    await notifier.sendReminder({
      ...base,
      audience: 'attendee',
      template: defaultTemplate('attendee_reminder'),
      reminderLeadMinutes: 60,
    });
    expect(email.sent[0]!.text).toContain('starts in 1 hour(s)');
    expect(email.sent[0]!.idempotencyKey).toBe('calendar:bk-123:reminder:60');
  });

  it('LEGACY: no audience/template keeps the old single-mail behavior', async () => {
    await notifier.sendConfirmation(base);
    const m = email.sent[0]!;
    expect(recipients(m)).toEqual(['alex@example.com', 'jordan@example.com', 'sam@example.com']);
    expect(m.subject).toMatch(/^Confirmed: Intro Call/);
    expect(m.text).toContain('Manage your booking:');
  });
});
