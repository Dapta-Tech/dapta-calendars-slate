import {
  MAX_CALENDAR_DESCRIPTION,
  MAX_CALENDAR_TITLE,
  calendarTemplateValues,
  renderCalendarText,
  type CalendarTextInput,
} from './template-calendar';
import {
  MAX_TEMPLATE_LIST_ITEMS,
  TEMPLATE_CATALOG,
  formatTemplateTime,
  templateErrors,
  templateIssueMessage,
  validateTemplate,
  variablesFor,
} from './template';

const input = (over: Partial<CalendarTextInput> = {}): CalendarTextInput => ({
  locale: 'en',
  seated: false,
  uid: 'b7c1e2d4',
  eventName: 'Product demo',
  eventDescription: 'A 30 minute walkthrough.',
  startUtc: '2026-10-21T15:00:00.000Z',
  endUtc: '2026-10-21T15:30:00.000Z',
  location: 'Video call',
  workspaceName: 'Dapta',
  teamName: null,
  host: { name: 'Felipe Gómez', email: 'felipe@example.com', timeZone: 'America/Bogota' },
  attendee: { name: 'Ana María López', email: 'ana@example.com', phone: ' +57 300 ', timeZone: 'America/New_York' },
  answers: { company: 'Acme', plan: 'Pro', newbie: true, secret: 'not asked' },
  questions: ['company', 'plan', 'newbie'],
  ...over,
});

describe('renderCalendarText', () => {
  it('renders a host-written title with the invitee name', () => {
    expect(renderCalendarText({ title: 'Reunión Felipe - {{name}}' }, input())).toEqual({
      title: 'Reunión Felipe - Ana María López',
    });
  });

  it('leaves a text without a template undefined, so the booking keeps what it has', () => {
    expect(renderCalendarText({}, input())).toEqual({});
    expect(renderCalendarText({ title: '  ', description: null }, input())).toEqual({});
  });

  it('writes the description from the answers, with blocks', () => {
    const out = renderCalendarText(
      {
        title: '{{event_name}} with {{first_name}}',
        description: [
          'Booked: {{event_title}}',
          '{{#if form.company}}Company: {{form.company}}{{/if}}',
          '{{#if form.plan == "pro"}}Priority account{{else}}Standard{{/if}}',
          'First call: {{form.newbie}}',
          'Phone: {{attendee_phone}}',
          'Their time: {{start_time_attendee}}',
        ].join('\n'),
      },
      input(),
    );
    expect(out.title).toBe('Product demo with Ana');
    expect(out.description).toBe(
      [
        'Booked: Product demo with Ana',
        'Company: Acme',
        'Priority account',
        'First call: Yes',
        'Phone: +57 300',
        `Their time: ${formatTemplateTime('2026-10-21T15:00:00.000Z', 'America/New_York')}`,
      ].join('\n'),
    );
  });

  it('reads times in the host zone and words them in the host language', () => {
    const out = renderCalendarText(
      { title: '{{start_time}}', description: '{{start_time}} ({{time_zone}}), {{duration}}' },
      input({ locale: 'es' }),
    );
    const when = formatTemplateTime('2026-10-21T15:00:00.000Z', 'America/Bogota', 'es');
    expect(when).toContain('10:00');
    expect(out.title).toBe(when.replace(/\s+/g, ' '));
    expect(out.description).toBe(`${when} (America/Bogota), 30 min`);
  });

  it('falls back to the invitee zone, then UTC, when a zone is unreadable', () => {
    const out = renderCalendarText(
      { description: '{{time_zone}}' },
      input({ host: { name: 'F', timeZone: 'Mars/Base' }, attendee: { name: 'A', timeZone: null } }),
    );
    expect(out.description).toBe('UTC');
  });

  it('falls back to the event name when the title renders empty', () => {
    expect(renderCalendarText({ title: '{{form.company}}' }, input({ answers: {} })).title).toBe('Product demo');
    // The name is printed as written, never parsed as a template.
    expect(
      renderCalendarText({ title: '{{form.company}}' }, input({ answers: {}, eventName: 'Demo {{name}}' })).title,
    ).toBe('Demo {{name}}');
  });

  it('reads the stored booking title as {{event_title}} when there is no title template', () => {
    expect(renderCalendarText({ description: 'Re: {{event_title}}' }, input({ bookingTitle: 'Old name' })).description).toBe(
      'Re: Old name',
    );
    expect(renderCalendarText({ description: 'Re: {{event_title}}' }, input()).description).toBe('Re: Product demo');
  });

  it('leaves the description null when it renders empty', () => {
    expect(renderCalendarText({ description: '{{form.company}}' }, input({ answers: {} })).description).toBeNull();
  });

  it('reads only the answers to questions the event asks', () => {
    expect(renderCalendarText({ description: '{{form.company}}{{form.secret}}' }, input()).description).toBe('Acme');
  });

  it('keeps a stored template from reading outside its context', () => {
    // Refused at save; if one slips through it renders empty, never the capability.
    const out = renderCalendarText(
      {
        title: 'a{{manage_url}}{{guests}}{{meeting_url}}{{host_email}}b',
        description: 'c{{booking_link}}{{cancel_link}}d {{host_name}}',
      },
      input(),
    );
    expect(out).toEqual({ title: 'ab', description: 'cd Felipe Gómez' });
  });

  it('takes angle brackets, line breaks and controls out of values', () => {
    const out = renderCalendarText(
      { title: 'Call {{name}}', description: 'Notes: {{form.company}}' },
      input({
        attendee: { name: 'Ana\r\nBCC: x <script>\u202Eevil', email: 'a@x.co' },
        answers: { company: '<a href="https://evil.example">click</a>\rline' },
      }),
    );
    expect(out.title).toBe('Call Ana BCC: x scriptevil');
    expect(out.description).toBe('Notes: a href="https://evil.example"click/a\nline');
  });

  it('treats the Unicode line and paragraph separators as line breaks', () => {
    const out = renderCalendarText(
      { title: 'Call {{name}}', description: 'Notes: {{form.company}}' },
      input({ attendee: { name: 'Ana\u2028X' }, answers: { company: 'a\u2028b\u2029c' } }),
    );
    expect(out.title).toBe('Call Ana X');
    expect(out.description).toBe('Notes: a\nb\nc');
  });

  it('cuts a huge list answer before formatting it', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `item${i}`);
    const out = renderCalendarText({ description: '{{form.company}}' }, input({ answers: { company: many } }));
    expect(out.description!.split(', ')).toHaveLength(MAX_TEMPLATE_LIST_ITEMS);
  });

  it('never expands a value as a template (single pass)', () => {
    const out = renderCalendarText({ title: '{{name}}' }, input({ attendee: { name: '{{attendee_email}}' } }));
    expect(out.title).toBe('{{attendee_email}}');
  });

  it('caps the title and the description', () => {
    const long = 'x'.repeat(190);
    const title = renderCalendarText({ title: `${long} {{name}} {{name}}` }, input({ attendee: { name: 'y'.repeat(190) } }));
    expect(title.title!.length).toBe(MAX_CALENDAR_TITLE);
    expect(title.title!.endsWith('…')).toBe(true);
    const body = renderCalendarText(
      { description: Array.from({ length: 9 }, () => '{{form.company}}').join('\n') },
      input({ answers: { company: 'z'.repeat(1990) } }),
    );
    expect(body.description!.length).toBe(MAX_CALENDAR_DESCRIPTION);
  });

  it('never throws on a malformed stored template', () => {
    expect(renderCalendarText({ title: '{{#if x}}open', description: '{{/if}}{{' }, input())).toEqual({
      title: '{{#if x}}open',
      description: '{{/if}}{{',
    });
  });
});

describe('seated events', () => {
  const PER_INVITEE = TEMPLATE_CATALOG.filter((d) => d.perInvitee).map((d) => d.name);

  it('marks the invitee data, and nothing that belongs to the booking or the host', () => {
    expect(PER_INVITEE.sort()).toEqual(
      [
        'attendee_email',
        'attendee_first_name',
        'attendee_name',
        'attendee_phone',
        'attendee_time_zone',
        'end_time_attendee',
        'start_time_attendee',
      ].sort(),
    );
  });

  it('refuses one invitee data and every answer in the shared title and description', () => {
    for (const context of ['title', 'description'] as const) {
      for (const d of variablesFor(context).filter((v) => v.perInvitee)) {
        expect(templateErrors(`{{${d.name}}}`, { context, seated: true }).map((i) => i.code), d.name).toEqual([
          'per_invitee',
        ]);
      }
      expect(templateErrors('{{name}}', { context, seated: true }).map((i) => i.code)).toEqual(['per_invitee']);
      expect(
        templateErrors('{{#if form.company}}x{{/if}}', { context, seated: true, questions: ['company'] }).map(
          (i) => i.code,
        ),
      ).toEqual(['per_invitee']);
      expect(templateErrors('{{event_name}} {{host_name}} {{start_time}}', { context, seated: true })).toEqual([]);
    }
    expect(templateErrors('{{name}} {{form.company}}', { context: 'title', questions: ['company'] })).toEqual([]);
  });

  it('explains the refusal in both languages', () => {
    const [issue] = validateTemplate('{{name}}', { context: 'title', seated: true });
    expect(templateIssueMessage(issue!, 'en')).toBe(
      "{{name}} is one invitee's data, and everyone who takes a seat sees this event.",
    );
    expect(templateIssueMessage(issue!, 'es')).toContain('todos los que reservan un cupo');
  });

  it('never reads a stored title, nor the invitee zone, on a shared slot', () => {
    const shared = input({ seated: true, bookingTitle: 'Office hours - Alice', host: { name: 'F', timeZone: null } });
    expect(renderCalendarText({ description: 'Re: {{event_title}} ({{time_zone}})' }, shared).description).toBe(
      'Re: Product demo (UTC)',
    );
  });

  it('renders invitee data empty even if a stored template names it', () => {
    const out = renderCalendarText(
      { title: 'Workshop {{name}} {{form.company}}', description: '{{host_name}}: {{email}}{{form.plan}}' },
      input({ seated: true }),
    );
    expect(out).toEqual({ title: 'Workshop', description: 'Felipe Gómez:' });
    const values = calendarTemplateValues(input({ seated: true }), 'description');
    for (const name of PER_INVITEE) expect(Object.hasOwn(values, name), name).toBe(false);
    expect(Object.keys(values).some((k) => k.startsWith('form.'))).toBe(false);
  });
});

describe('calendarTemplateValues', () => {
  it('offers exactly the catalog variables of the context, plus the asked answers', () => {
    for (const context of ['title', 'description'] as const) {
      const values = calendarTemplateValues(input(), context);
      expect(
        Object.keys(values)
          .filter((k) => !k.startsWith('form.'))
          .sort(),
      ).toEqual(
        variablesFor(context)
          .map((d) => d.name)
          .sort(),
      );
      expect(Object.keys(values).filter((k) => k.startsWith('form.')).sort()).toEqual([
        'form.company',
        'form.newbie',
        'form.plan',
      ]);
    }
  });

  it('has no prototype to reach', () => {
    const values = calendarTemplateValues(input({ answers: { constructor: 'x' }, questions: ['constructor'] }), 'title');
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(renderCalendarText({ title: 'a{{__proto__}}{{constructor}}b' }, input()).title).toBe('ab');
  });
});
