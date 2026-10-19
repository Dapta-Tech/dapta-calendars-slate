import { describe, it, expect, beforeEach } from 'vitest';
import { BookingNotifier, type BookingNotification } from './booking-notifier';
import type { EmailMessage, EmailProvider, EmailResult } from './email.port';
import { variablesFor } from '@slate/engine';
import {
  DEFAULT_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  MAX_RENDERED_SUBJECT,
  TEMPLATE_VARIABLES,
  defaultTemplate,
  extractTokens,
  formatDuration,
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
        'es',
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

describe('the template engine in emails', () => {
  const withAnswers = (answers: Record<string, unknown>): BookingNotification => ({
    ...base,
    formAnswers: answers,
  });

  it('offers exactly the engine catalog for emails', () => {
    expect([...TEMPLATE_VARIABLES]).toEqual(variablesFor('email').map((d) => d.name));
  });

  it('resolves the new variables from the notification', () => {
    const n: BookingNotification = {
      ...base,
      host: { ...base.host, timeZone: 'Europe/Madrid' },
      attendee: { ...base.attendee, phone: ' +1 555 0100 ' },
      guests: [{ name: 'Lu', email: 'lu@example.com' }, { name: null, email: 'mo@example.com' }],
      eventName: 'Intro',
      eventDescription: 'A first call.',
      workspaceName: 'Acme',
      teamName: 'Sales',
      audience: 'host',
    };
    const v = templateVars(n);
    expect(v.attendee_first_name).toBe('Sam');
    expect(v.attendee_phone).toBe('+1 555 0100');
    expect(v.guests).toBe('lu@example.com, mo@example.com');
    expect(v.attendee_time_zone).toBe('America/New_York');
    expect(v.host_email).toBe('alex@example.com');
    expect(v.event_name).toBe('Intro');
    expect(v.event_title).toBe('Intro Call');
    expect(v.event_description).toBe('A first call.');
    expect(v.duration).toBe('30 min');
    expect(v.workspace_name).toBe('Acme');
    expect(v.team_name).toBe('Sales');
    expect(v.booking_uid).toBe('bk-123');
    // The host reads in their zone; the explicit variants name one side.
    expect(v.time_zone).toBe('Europe/Madrid');
    expect(v.start_time).toMatch(/5:00/);
    expect(v.start_time_host).toBe(v.start_time);
    expect(v.end_time_host).toMatch(/5:30/);
    expect(v.start_time_attendee).toMatch(/11:00/);
    // The invitee's copy never lists the other people on the booking.
    expect(templateVars({ ...n, audience: 'attendee' }).guests).toBe('');
    expect(templateVars({ ...n, audience: 'attendee' }).time_zone).toBe('America/New_York');
  });

  it('reads a payload queued before the new fields as the old mail did', () => {
    const v = templateVars(base);
    expect(v.event_name).toBe('Intro Call');
    expect(v.event_description).toBe('');
    expect(v.team_name).toBe('');
    // No host zone carried: the host-side times fall back to the invitee's.
    expect(v.start_time_host).toBe(v.start_time_attendee);
  });

  it('formats a duration in hours and minutes', () => {
    expect(formatDuration('2026-08-01T15:00:00Z', '2026-08-01T15:30:00Z')).toBe('30 min');
    expect(formatDuration('2026-08-01T15:00:00Z', '2026-08-01T16:00:00Z')).toBe('1 h');
    expect(formatDuration('2026-08-01T15:00:00Z', '2026-08-01T16:45:00Z')).toBe('1 h 45 min');
    expect(formatDuration('bad', '2026-08-01T16:45:00Z')).toBe('');
  });

  it('renders fallbacks and blocks that depend on the answers', () => {
    const t = {
      subject: 'Hi {{attendee_first_name | "there"}}: {{event_name}}',
      body: [
        'Hello {{name}},',
        '{{#if form.company}}',
        'Company: {{form.company}}',
        '{{/if}}',
        '{{#if form.plan == "pro"}}',
        'A specialist will join.',
        '{{else}}',
        'See you soon.',
        '{{/if}}',
        '{{#if form.tools contains "Calendars"}}Calendars user.{{/if}}',
        '{{#if form.newbie}}First time.{{/if}}',
      ].join('\n'),
    };
    const pro = renderTemplate(
      t,
      templateVars(withAnswers({ company: 'Acme', plan: 'Pro', tools: ['Forms', 'Calendars'], newbie: false })),
    );
    expect(pro.subject).toBe('Hi Sam: Intro Call');
    expect(pro.text).toBe('Hello Sam Guest,\nCompany: Acme\nA specialist will join.\nCalendars user.');
    const basic = renderTemplate(t, templateVars({ ...withAnswers({ plan: 'Basic' }), attendee: { ...base.attendee, name: '' } }));
    expect(basic.subject).toBe('Hi there: Intro Call');
    // "Hello {{name}}," with no name is a line whose only value is empty: dropped.
    expect(basic.text).toBe('See you soon.');
  });

  it('never expands a template an invitee typed into an answer', () => {
    const r = renderTemplate(
      { subject: '{{form.company}}', body: 'Company: {{form.company}}' },
      templateVars(withAnswers({ company: '{{manage_url}} {{#if attendee_email}}x{{/if}}' })),
    );
    expect(r.subject).toBe('{{manage_url}} {{#if attendee_email}}x{{/if}}');
    expect(r.text).toBe('Company: {{manage_url}} {{#if attendee_email}}x{{/if}}');
    expect(r.html).not.toContain('https://');
  });

  it('keeps the subject on one capped line, whatever the values hold', () => {
    const evil = { ...base, title: `Intro\r\nBcc: x@evil.test\u202E ${'y'.repeat(400)}` };
    const r = renderTemplate({ subject: '{{event_title}} {{event_title}}', body: 'b' }, templateVars(evil));
    expect(r.subject).not.toMatch(/[\r\n\u202E]/);
    expect(r.subject.length).toBeLessThanOrEqual(MAX_RENDERED_SUBJECT);
  });
});

/**
 * The renderer this module shipped before the engine, verbatim. Every template
 * a host could save with it must render byte for byte the same on the engine;
 * only what it could not read (aliases, fallbacks, blocks) may differ.
 */
const OLD_TOKEN_RE = /\{\{\s*([a-z_]+|form\.[A-Za-z0-9_]{1,64})\s*\}\}/g;
function oldRender(template: { subject: string; body: string }, vars: Record<string, unknown>) {
  const value = (name: string): string => {
    if (!Object.hasOwn(vars, name)) return '';
    const v = vars[name];
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.map(String).filter(Boolean).join(', ');
    return String(v);
  };
  const subject = template.subject
    .replace(OLD_TOKEN_RE, (_, name: string) => value(name))
    .replace(/\s+/g, ' ')
    .trim();
  const lines = template.body
    .split('\n')
    .map((line) => {
      let sawToken = false;
      let sawValue = false;
      const out = line.replace(OLD_TOKEN_RE, (_, name: string) => {
        sawToken = true;
        const v = value(name);
        if (v !== '') sawValue = true;
        return v;
      });
      return sawToken && !sawValue ? null : out;
    })
    .filter((l): l is string => l !== null);
  return { subject, text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

describe('the engine renders every old template as the old renderer did', () => {
  const vars = templateVars({
    ...base,
    cancellationReason: 'Line one\nline two',
    formAnswers: { topic: 'Pricing', tools: ['Forms', 'Calendars'], newbie: true, empty: '' },
  });
  const corpus: Array<{ subject: string; body: string }> = [
    ...EMAIL_TEMPLATE_KEYS.flatMap((k) => [DEFAULT_TEMPLATES.en[k], DEFAULT_TEMPLATES.es[k]]),
    { subject: '{{{attendee_name}}}', body: '{{{attendee_name}}}\n{{ host_name }}\n{{Name}} {{abc1}}' },
    { subject: 'x {{__proto__}} {{constructor}}', body: 'A{{__proto__}}\nB {{constructor}} {{location}}' },
    { subject: 's', body: `Long {{${'a'.repeat(80)}}}\nkeep\r\nCRLF {{attendee_name}}\r\n{{nope}}\r\nend` },
    { subject: 's', body: 'Topic: {{form.topic}}\nTools: {{form.tools}}\nNew: {{form.newbie}}\nEmpty: {{form.empty}}' },
    { subject: 's', body: 'Why: {{cancellation_reason}}\n\n\n\nAfter {{form.missing}} {{form.a-b}}' },
    { subject: 'a\tb  {{attendee_name}}\n', body: '{{ {{attendee_name}} }}\n{{attendee_name\n}}\nx {{ }} y' },
    { subject: '{{else}} {{/if}}', body: 'Hi {{else}}\nThere {{/if}}\n{{#if x}}' },
  ];

  it.each(corpus.map((t, n) => [n, t] as const))('template %i', (_n, t) => {
    const now = renderTemplate(t, vars);
    expect({ subject: now.subject, text: now.text }).toEqual(oldRender(t, vars));
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

/**
 * The production case behind this: a host in Bogota received "New booking: ... Thu,
 * Oct 29, 12:00 PM MST" because the host copy was formatted in the invitee's
 * zone (America/Phoenix). Each side now reads the time in its own zone.
 */
describe('each side reads the time in its own zone', () => {
  let email: RecordingEmailProvider;
  let notifier: BookingNotifier;
  beforeEach(() => {
    email = new RecordingEmailProvider();
    notifier = new BookingNotifier(email);
  });
  const crossZone: BookingNotification = {
    ...base,
    coHosts: [],
    startUtc: '2026-10-29T19:00:00.000Z',
    endUtc: '2026-10-29T19:30:00.000Z',
    host: { name: 'Alex Rivera', email: 'alex@example.com', timeZone: 'America/Bogota' },
    attendee: { name: 'Sam Guest', email: 'sam@example.com', timeZone: 'America/Phoenix' },
  };
  const HOST_TIME = /Thu, Oct 29, 2:00\sPM GMT-5/u;
  const GUEST_TIME = /Thu, Oct 29, 12:00\sPM MST/u;

  it("the host copy states the host's time in the subject, the text and the HTML", async () => {
    await notifier.sendConfirmation({ ...crossZone, audience: 'host', template: defaultTemplate('host_booked') });
    const m = email.sent[0]!;
    expect(m.subject).toMatch(/^New booking: Intro Call/);
    for (const part of [m.subject, m.text, String(m.html)]) {
      expect(part).toMatch(HOST_TIME);
      expect(part).not.toMatch(GUEST_TIME);
    }
  });

  it("the invitee copy keeps the invitee's time", async () => {
    await notifier.sendConfirmation({ ...crossZone, audience: 'attendee', template: defaultTemplate('attendee_confirmation') });
    const m = email.sent[0]!;
    for (const part of [m.subject, m.text, String(m.html)]) {
      expect(part).toMatch(GUEST_TIME);
      expect(part).not.toMatch(HOST_TIME);
    }
  });

  it("a reschedule's previous time is in the reader's zone too, template or not", async () => {
    for (const template of [defaultTemplate('host_rescheduled'), null]) {
      email.sent.length = 0;
      await notifier.sendReschedule({
        ...crossZone,
        audience: 'host',
        template,
        previousStartUtc: '2026-10-28T19:00:00.000Z',
      });
      const m = email.sent[0]!;
      expect(m.subject, String(!!template)).toMatch(HOST_TIME);
      expect(m.text, String(!!template)).toMatch(/Was: Wed, Oct 28, 2:00\sPM GMT-5/u);
    }
  });

  it('Spanish host copies use the host zone as well', async () => {
    await notifier.sendCancellation({
      ...crossZone,
      audience: 'host',
      templateLocale: 'es',
      template: defaultTemplate('host_cancelled', 'es'),
    });
    expect(email.sent[0]!.subject).toMatch(/jue, 29 oct, 14:00 GMT-5/u);
  });

  it("a host copy with no host zone keeps the invitee's zone", async () => {
    await notifier.sendConfirmation({
      ...crossZone,
      host: { name: 'Alex Rivera', email: 'alex@example.com' },
      audience: 'host',
      template: defaultTemplate('host_booked'),
    });
    expect(email.sent[0]!.subject).toMatch(GUEST_TIME);
  });

  it("an unreadable stored host zone falls back to the invitee's zone, never a raw instant", async () => {
    await notifier.sendConfirmation({
      ...crossZone,
      host: { name: 'Alex Rivera', email: 'alex@example.com', timeZone: 'Not/AZone' },
      audience: 'host',
      template: defaultTemplate('host_booked'),
    });
    expect(email.sent[0]!.subject).toMatch(GUEST_TIME);
    expect(email.sent[0]!.subject).not.toContain('2026-10-29T');
  });

  it("a legacy message with no audience keeps the invitee's zone for everyone", async () => {
    await notifier.sendConfirmation(crossZone);
    expect(email.sent[0]!.subject).toMatch(GUEST_TIME);
    expect(templateVars(crossZone).start_time).toMatch(GUEST_TIME);
  });
});
