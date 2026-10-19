import {
  MAX_TEMPLATE_DEPTH,
  TEMPLATE_CATALOG,
  TEMPLATE_CONTEXTS,
  canonicalVariable,
  cleanTemplateValue,
  formatTemplateValue,
  parseTemplate,
  renderTemplate,
  templateErrors,
  templateIssueMessage,
  templateVariableNames,
  validateTemplate,
  variablesFor,
  type TemplateValues,
} from './template';

const values: TemplateValues = {
  attendee_name: 'Ana Gómez',
  attendee_first_name: 'Ana',
  host_name: 'Felipe',
  location: '',
  'form.company': 'Acme',
  'form.plan': 'Pro',
  'form.tools': ['Forms', 'Calendars'],
  'form.newbie': true,
  'form.returning': false,
};

const line = (t: string, v: TemplateValues = values) => renderTemplate(t, v, { mode: 'line' });
const text = (t: string, v: TemplateValues = values) => renderTemplate(t, v, { mode: 'text' });
const codes = (t: string, context: 'title' | 'description' | 'email' = 'email', questions?: string[]) =>
  validateTemplate(t, { context, questions }).map((i) => i.code);

describe('catalog', () => {
  it('has unique names, labels and samples in both languages, and valid contexts', () => {
    const names = TEMPLATE_CATALOG.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of TEMPLATE_CATALOG) {
      expect(d.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(d.label.en && d.label.es && d.sample.en && d.sample.es, d.name).toBeTruthy();
      expect(d.contexts.length, d.name).toBeGreaterThan(0);
      for (const c of d.contexts) expect(TEMPLATE_CONTEXTS).toContain(c);
    }
  });

  it('keeps every email-only capability out of the calendar event', () => {
    // The manage link is a capability: a calendar event is shared with guests.
    for (const name of ['manage_url', 'cancel_link', 'reschedule_link', 'meeting_url']) {
      expect(variablesFor('title').map((d) => d.name)).not.toContain(name);
      expect(variablesFor('description').map((d) => d.name)).not.toContain(name);
      expect(variablesFor('email').map((d) => d.name)).toContain(name);
    }
  });

  it('keeps the other guests to the host side of email', () => {
    expect(variablesFor('email').map((d) => d.name)).toContain('guests');
    expect(variablesFor('email', 'host').map((d) => d.name)).toContain('guests');
    expect(variablesFor('email', 'invitee').map((d) => d.name)).not.toContain('guests');
    expect(variablesFor('description').map((d) => d.name)).not.toContain('guests');
    expect(codes('{{guests}}')).toEqual(['host_only']);
    expect(validateTemplate('{{guests}}', { context: 'email', audience: 'host' })).toEqual([]);
  });

  it('resolves the short aliases to canonical names', () => {
    expect(canonicalVariable('name')).toBe('attendee_name');
    expect(canonicalVariable('first_name')).toBe('attendee_first_name');
    expect(canonicalVariable('email')).toBe('attendee_email');
    expect(canonicalVariable('host_name')).toBe('host_name');
    expect(canonicalVariable('constructor')).toBe('constructor');
  });
});

describe('renderTemplate: values, fallbacks and aliases', () => {
  it('renders the title Felipe asked for', () => {
    expect(line('Reunión Felipe - {{name}}')).toBe('Reunión Felipe - Ana Gómez');
  });

  it('accepts whitespace inside tags', () => {
    expect(line('{{ attendee_first_name }}!')).toBe('Ana!');
  });

  it('uses the fallback only when the value is empty', () => {
    expect(line('Hi {{attendee_first_name | "there"}}')).toBe('Hi Ana');
    expect(line('Hi {{attendee_first_name | "there"}}', {})).toBe('Hi there');
    expect(line('At {{location | default: "TBD"}}')).toBe('At TBD');
    expect(line("At {{location | 'TBD'}}")).toBe('At TBD');
    expect(line('At {{location | “TBD”}}')).toBe('At TBD');
  });

  it('formats lists and yes/no answers in the reader language', () => {
    expect(line('{{form.tools}}')).toBe('Forms, Calendars');
    expect(line('{{form.newbie}}')).toBe('Yes');
    expect(renderTemplate('{{form.newbie}}', values, { mode: 'line', locale: 'es' })).toBe('Sí');
    expect(formatTemplateValue([true, 3, 'x', null as unknown as string], 'es')).toBe('Sí, 3, x');
    expect(formatTemplateValue(Number.NaN)).toBe('');
  });

  it('keeps a malformed tag as written instead of failing', () => {
    expect(line('{{Name}} {{attendee_name}}')).toBe('{{Name}} Ana Gómez');
    expect(line('open {{attendee_name')).toBe('open {{attendee_name');
    // A triple brace still finds the inner tag, as the first email renderer did.
    expect(line('{{{name}}}')).toBe('{Ana Gómez}');
  });

  it('renders an unknown name as empty', () => {
    expect(line('a {{nope}} b')).toBe('a b');
  });
});

describe('renderTemplate: conditionals', () => {
  it('shows a block only when the value is present', () => {
    expect(line('{{#if form.company}}at {{form.company}}{{/if}}')).toBe('at Acme');
    expect(line('x{{#if form.missing}}never{{/if}}y')).toBe('xy');
  });

  it('treats a false yes/no answer as absent and a true one as present', () => {
    expect(line('{{#if form.newbie}}new{{else}}old{{/if}}')).toBe('new');
    expect(line('{{#if form.returning}}back{{else}}first{{/if}}')).toBe('first');
  });

  it('compares with ==, != and contains, ignoring case and surrounding space', () => {
    expect(line('{{#if form.plan == "pro"}}VIP{{else}}std{{/if}}')).toBe('VIP');
    expect(line('{{#if form.plan == " PRO "}}VIP{{/if}}')).toBe('VIP');
    expect(line('{{#if form.plan != "Pro"}}no{{else}}yes{{/if}}')).toBe('yes');
    expect(line('{{#if form.tools contains "calendars"}}cal{{/if}}')).toBe('cal');
    expect(line('{{#if form.tools contains "Cal"}}partial{{else}}item{{/if}}')).toBe('item');
    expect(line('{{#if form.company contains "cm"}}phrase{{/if}}')).toBe('phrase');
    expect(line('{{#if form.newbie == "sí"}}y{{/if}}{{#if form.returning == "no"}}n{{/if}}')).toBe('yn');
  });

  it('nests blocks', () => {
    expect(text('A\n{{#if form.company}}\n{{#if form.plan}}\nB\n{{/if}}\n{{/if}}\nC')).toBe('A\nB\nC');
  });
});

describe('renderTemplate: text mode lines', () => {
  it('drops a block tag that is alone on its line together with the line', () => {
    expect(text('Hi,\n{{#if form.company}}\nCompany: {{form.company}}\n{{/if}}\nThanks')).toBe(
      'Hi,\nCompany: Acme\nThanks',
    );
    expect(text('Hi,\n{{#if form.nope}}\nCompany: x\n{{/if}}\nThanks')).toBe('Hi,\nThanks');
  });

  it('keeps an inline block tag inline', () => {
    expect(text('{{name}} {{#if form.company}}\nX{{/if}}')).toBe('Ana Gómez \nX');
  });

  it('drops a line whose variables all came out empty, and keeps literal lines', () => {
    expect(text('Hi\nWhere: {{location}}\n\nBye')).toBe('Hi\n\nBye');
    expect(text('Where: {{location}} {{host_name}}')).toBe('Where:  Felipe');
  });

  it('does not split a template line on a line break inside a value', () => {
    expect(text('Notes: {{form.notes}}', { 'form.notes': 'one\ntwo' })).toBe('Notes: one\ntwo');
  });

  it('collapses runs of blank lines and trims', () => {
    expect(text('\n\nA\n\n\n\nB\n\n')).toBe('A\n\nB');
  });
});

describe('renderTemplate: safety', () => {
  it('never expands a template written inside an answer (single pass)', () => {
    const v = { 'form.company': '{{attendee_email}} {{#if x}}y{{/if}}', attendee_email: 'secret@x.com' };
    expect(line('{{form.company}}', v)).toBe('{{attendee_email}} {{#if x}}y{{/if}}');
  });

  it('never reads Object.prototype', () => {
    expect(line('a{{constructor}}{{__proto__}}{{to_string}}{{form.__proto__}}{{form.constructor}}b')).toBe('ab');
    expect(line('{{#if constructor}}leak{{/if}}{{#if __proto__}}leak{{/if}}ok')).toBe('ok');
    expect(codes('{{__proto__}}')).toEqual(['unknown_variable']);
  });

  it('folds line breaks in single-line mode so a value cannot start a header line', () => {
    expect(line('S: {{attendee_name}}', { attendee_name: 'Ana\r\nBcc: evil@x.com' })).toBe('S: Ana Bcc: evil@x.com');
    expect(line('S: {{attendee_name}}', { attendee_name: 'Ana\rX' })).toBe('S: Ana X');
  });

  it('removes control and bidi characters from values', () => {
    const v = { attendee_name: 'A\u0000B\u0007C\u202Ecba\u2066D\u200FE\u0085F' };
    expect(line('{{attendee_name}}', v)).toBe('ABCcbaDEF');
    // Text mode keeps line breaks and tabs, still drops the rest.
    expect(text('{{attendee_name}}', { attendee_name: 'a\tb\nc\u202Ed' })).toBe('a\tb\ncd');
  });

  it('removes the Arabic letter mark and invisible spaces, keeps the joiners emoji need', () => {
    const v = { attendee_name: 'A\u061CB\u200BC\u2060D\uFEFFE' };
    expect(line('{{attendee_name}}', v)).toBe('ABCDE');
    const family = '\uD83D\uDC69\u200D\uD83D\uDC67';
    expect(line('{{attendee_name}}', { attendee_name: family })).toBe(family);
  });

  it('never cuts an emoji in half at the cap', () => {
    const out = cleanTemplateValue(`${'a'.repeat(198)}\uD83D\uDE00tail`, { mode: 'line' });
    expect(out).toBe(`${'a'.repeat(198)}…`);
  });

  it('can strip angle brackets for sinks that may read markup', () => {
    expect(
      renderTemplate('{{attendee_name}}', { attendee_name: '<a href=x>hi</a>' }, { mode: 'text', stripAngleBrackets: true }),
    ).toBe('a href=xhi/a');
  });

  it('caps each value and the whole output', () => {
    const long = 'x'.repeat(500);
    expect(line('{{attendee_name}}', { attendee_name: long })).toHaveLength(200);
    expect(text('{{attendee_name}}', { attendee_name: 'y'.repeat(5000) })).toHaveLength(2000);
    expect(renderTemplate('{{attendee_name}} tail', { attendee_name: long }, { mode: 'line', maxLength: 50 })).toHaveLength(50);
    expect(cleanTemplateValue('abcdef', { mode: 'line', maxValueLength: 4 })).toBe('abc…');
  });

  it('treats a non-finite or object value as empty', () => {
    const v = { attendee_name: { toString: () => 'boom' } as unknown as string, host_name: Number.POSITIVE_INFINITY };
    expect(line('[{{attendee_name}}][{{host_name}}]', v)).toBe('[][]');
  });
});

describe('renderTemplate: stored text reads as the first email renderer read it', () => {
  it('keeps its name charset: digits print as text, any lowercase name resolves', () => {
    expect(text('Code {{abc1}}')).toBe('Code {{abc1}}');
    expect(text(`Code {{${'a'.repeat(80)}}}`)).toBe('');
    expect(text(`Keep {{${'a'.repeat(80)}}} {{host_name}}`)).toBe('Keep  Felipe');
  });

  it('never reads a tag across lines', () => {
    expect(text('{{@N@attendee_name@N@}}'.replace(/@N@/g, '\n'))).toBe('{{\nattendee_name\n}}');
  });

  it('prints a block that does not pair up as written, so nothing after it is hidden', () => {
    expect(text('Hi\n{{#if form.vip}}\nVIP\nThanks')).toBe('Hi\n{{#if form.vip}}\nVIP\nThanks');
    expect(text('Hi {{/if}} there')).toBe('Hi {{/if}} there');
    expect(text('A {{#if form.company}}x{{/if}} {{/if}} B')).toBe('A x {{/if}} B');
    // An `{{else}}` outside a block is an unknown name: empty, and its line drops.
    expect(text('Hi {{else}}\nNext')).toBe('Next');
    // Inside a block that never closes, the `{{else}}` is outside every block
    // too, so its line drops, as the first renderer dropped it.
    expect(text('{{#if form.company}}A{{else}}B\nNext')).toBe('Next');
    expect(text('{{#if form.company}}A {{name}}{{else}}B')).toBe('{{#if form.company}}A Ana GómezB');
  });
});

describe('renderTemplate: blocks and blank lines', () => {
  it('drops a line left blank by an inline block', () => {
    expect(text('A\n{{#if form.missing}}Company: {{form.company}}{{/if}}\nB')).toBe('A\nB');
    expect(text('A\n  {{#if form.missing}}x{{/if}}  \nB')).toBe('A\nB');
    expect(text('A\n{{#if form.company}}Company: {{form.company}}{{/if}}\nB')).toBe('A\nCompany: Acme\nB');
  });

  it('keeps a blank line the host wrote after a standalone block', () => {
    expect(text('A\n{{#if form.missing}}\nB\n{{/if}}\n\nC')).toBe('A\n\nC');
    expect(text('A\n{{#if form.company}}\nB\n{{/if}}\n\nC')).toBe('A\nB\n\nC');
  });

  it('reads a yes/no answer by its word with contains, as with ==', () => {
    expect(line('{{#if form.newbie contains "yes"}}y{{/if}}{{#if form.newbie contains "es"}}partial{{/if}}')).toBe('y');
  });
});

describe('validateTemplate', () => {
  it('accepts a clean template', () => {
    expect(codes('Hi {{name}}, {{#if form.company}}at {{form.company | "home"}}{{/if}}', 'title')).toEqual([]);
  });

  it('flags unknown names and names not available in the context', () => {
    expect(codes('{{atendee}}', 'title')).toEqual(['unknown_variable']);
    expect(codes('{{manage_url}}', 'title')).toEqual(['not_available']);
    expect(codes('{{manage_url}}', 'description')).toEqual(['not_available']);
    expect(codes('{{manage_url}}', 'email')).toEqual([]);
    expect(codes('{{#if meeting_url}}x{{/if}}', 'description')).toEqual(['not_available']);
  });

  it('warns, without blocking, about a question the event does not ask', () => {
    const issues = validateTemplate('{{form.budget}} {{form.company}}', { context: 'title', questions: ['company'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'unknown_question', severity: 'warning', token: '{{form.budget}}' });
    expect(templateErrors('{{form.budget}}', { context: 'title', questions: ['company'] })).toEqual([]);
    // No event (an account-wide template): any well-formed question name is fine.
    expect(codes('{{form.anything}}')).toEqual([]);
  });

  it('flags broken blocks', () => {
    expect(codes('{{#if form.a}}x')).toEqual(['unclosed_block']);
    expect(codes('x{{/if}}')).toEqual(['stray_close']);
    expect(codes('{{else}}')).toEqual(['stray_else']);
    expect(codes('{{#if form.a}}a{{else}}b{{else}}c{{/if}}')).toEqual(['duplicate_else']);
    expect(codes('{{name')).toEqual(['unclosed_tag']);
    expect(codes('{{Bad Tag}}')).toEqual(['bad_tag']);
    expect(codes('{{#if form.a = "x"}}y{{/if}}')).toEqual(['bad_tag', 'stray_close']);
  });

  it('limits nesting depth and literal length', () => {
    const deep = '{{#if form.a}}'.repeat(MAX_TEMPLATE_DEPTH + 1) + 'x' + '{{/if}}'.repeat(MAX_TEMPLATE_DEPTH + 1);
    expect(codes(deep)).toEqual(['too_deep']);
    const ok = '{{#if form.a}}'.repeat(MAX_TEMPLATE_DEPTH) + 'x' + '{{/if}}'.repeat(MAX_TEMPLATE_DEPTH);
    expect(codes(ok)).toEqual([]);
    expect(codes(`{{name | "${'z'.repeat(101)}"}}`)).toEqual(['bad_literal']);
    expect(codes(`{{#if form.a == "${'z'.repeat(101)}"}}x{{/if}}`)).toEqual(['bad_literal']);
  });

  it('reports offsets that point at the tag as written', () => {
    const t = 'Hello {{atendee}} there';
    const [i] = validateTemplate(t, { context: 'title' });
    expect(t.slice(i!.start, i!.end)).toBe('{{atendee}}');
  });

  it('keeps offsets exact across standalone block lines', () => {
    const t = 'A\n{{#if form.a}}\n{{nope}}\n{{/if}}\nB';
    const [i] = validateTemplate(t, { context: 'email' });
    expect(t.slice(i!.start, i!.end)).toBe('{{nope}}');
  });

  it('lists the names a template reads, canonical and in order', () => {
    expect(templateVariableNames('{{name}} {{#if form.a}}{{host_name}}{{/if}} {{name}}')).toEqual([
      'attendee_name',
      'form.a',
      'host_name',
    ]);
  });

  it('quotes a token with a dollar sign as written', () => {
    expect(templateIssueMessage({ code: 'bad_tag', token: "{{cost $'}}" })).toBe(
      "{{cost $'}} is not valid. Variables look like {{attendee_name}}.",
    );
  });

  it('explains every issue in both languages', () => {
    const msg = templateIssueMessage({ code: 'unknown_variable', token: '{{x}}' }, 'es');
    expect(msg).toBe('{{x}} no es una variable. Elige una de la lista.');
    expect(templateIssueMessage({ code: 'not_available', token: '{{y}}' })).toBe('{{y}} is not available here.');
  });

  it('never throws on hostile input', () => {
    const junk = '{{'.repeat(2000) + '}}'.repeat(2000) + '{{#if'.repeat(500) + '{{/if}}'.repeat(500);
    expect(() => parseTemplate(junk)).not.toThrow();
    expect(() => renderTemplate(junk, values, { mode: 'text' })).not.toThrow();
  });

  it('stays linear on a wall of openings before one close', () => {
    const wall = '{{'.repeat(50_000) + '}}';
    const t0 = performance.now();
    parseTemplate(wall);
    parseTemplate('{{x'.repeat(30_000) + '}}');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
