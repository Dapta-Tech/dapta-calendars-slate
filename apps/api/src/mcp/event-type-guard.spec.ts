import { describe, expect, it } from 'vitest';
import { checkEventTypeEdit, containsUrl, eventTypeRevision, slugFromTitle } from './event-type-guard';

/** The guard on what an agent may write into an event type: pure, so every rule is a row here. */

const q = (over: Record<string, unknown> = {}) => ({ name: 'q1', label: 'Pick one', type: 'text', ...over });

describe('event-type guard', () => {
  it('sees a link wherever it starts, and only a link', () => {
    for (const text of [
      'https://x.test', 'see HTTP://x.test', 'www.x.test', 'Write mailto:a@x.test', 'ftp://x', 'javascript://x', '_https://x.y/p', '1https://x.y',
      'x_https://x.y', '_www.x.y', 'See //x.y/form', 'http:x.y', 'https:\\\\x.y', 'at \\\\host\\share', 'javascript:alert(1)', 'data:text/html,x',
      'ｈｔｔｐｓ://x.y', 'Pay first: _https://evil.example/pay', 'Register at evil-example.com/register', 'Visit evil.com', 'shop.xn--p1ai',
      'go to site.unknown/path', 'Call 10.0.0.1',
    ])
      expect(containsUrl(text), text).toBe(true);
    for (const text of ['Under 10k', 'a/b', 'Ratio 3:1 at 10:30', 'e-mail me', 'Topic: roadmap', 'www', 'Next.js', 'Node.js', 'e.g. a demo', 'v1.2', '3.5 hours', 'Your data: name and team'])
      expect(containsUrl(text), text).toBe(false);
  });

  it.each([
    [{ title: 'Call\u202Eevil' }, 'CHARACTERS_NOT_ALLOWED', 'title'],
    [{ title: 'Two\nlines' }, 'CHARACTERS_NOT_ALLOWED', 'title'],
    [{ questions: [q({ label: 'Hi\u200Bthere' })] }, 'CHARACTERS_NOT_ALLOWED', 'questions[0].label'],
    [{ title: 'Blank\u2800here' }, 'CHARACTERS_NOT_ALLOWED', 'title'],
    [{ title: 'a\u200Db' }, 'CHARACTERS_NOT_ALLOWED', 'title'],
    [{ description: 'One\u2028two' }, 'CHARACTERS_NOT_ALLOWED', 'description'],
    [{ questions: [q({ label: 'Hangul\u3164filler' })] }, 'CHARACTERS_NOT_ALLOWED', 'questions[0].label'],
    [{ questions: [q({ type: 'select', options: ['Private\uE000use'] })] }, 'CHARACTERS_NOT_ALLOWED', 'questions[0].options[0]'],
    [{ location: { kind: 'phone', detail: '+57\u200B300 123 4567' } }, 'CHARACTERS_NOT_ALLOWED', 'location.detail'],
    [{ location: { kind: 'in_person', detail: 'https:\\\\x.y' } }, 'URL_NOT_ALLOWED', 'location.detail'],
    [{ questions: [q({ placeholder: 'www.x.test' })] }, 'URL_NOT_ALLOWED', 'questions[0].placeholder'],
    [{ location: { kind: 'conferencing', detail: 'Room 4' } }, 'INVALID_ARGUMENT', 'location.detail'],
    [{ location: { kind: 'phone', detail: 'call me' } }, 'INVALID_ARGUMENT', 'location.detail'],
    [{ questions: Array.from({ length: 31 }, (_, i) => q({ name: `q${i}` })) }, 'INVALID_ARGUMENT', 'questions'],
    [{ questions: [q({ name: 'Bad-Name' })] }, 'INVALID_ARGUMENT', 'questions[0].name'],
    [{ questions: [q(), q()] }, 'INVALID_ARGUMENT', 'questions[1].name'],
    [{ questions: [q({ name: 'email' })] }, 'INVALID_ARGUMENT', 'questions[0].name'],
    [{ questions: [q({ type: 'select' })] }, 'INVALID_ARGUMENT', 'questions[0].options'],
    [{ questions: [q({ type: 'checkbox', options: Array.from({ length: 51 }, (_, i) => `o${i}`) })] }, 'INVALID_ARGUMENT', 'questions[0].options'],
    [{ questions: [q({ type: 'select', options: ['x'.repeat(201)] })] }, 'INVALID_ARGUMENT', 'questions[0].options[0]'],
  ])('refuses %j with %s on %s', (edit, code, field) => {
    expect(checkEventTypeEdit(edit as never, { existingQuestionNames: [] })).toMatchObject({ code, field });
  });

  it('lets through plain text, emoji, a phone number and a name the event type already uses', () => {
    expect(
      checkEventTypeEdit(
        {
          title: 'Coffee ☕️ chat with a 👩\u200D💻',
          description: 'Line one\nLine two',
          location: { kind: 'phone', detail: '+57 300 123 4567' },
          questions: [q({ name: 'Old Name' }), q({ name: 'size', type: 'select', options: ['< 10', '10+'] })],
        },
        { existingQuestionNames: ['Old Name'] },
      ),
    ).toBeNull();
  });

  it('keeps a guests question name taken, and lets the host\'s own stored text through', () => {
    expect(checkEventTypeEdit({ questions: [q({ name: 'cc' })] }, { existingQuestionNames: [], keptNames: ['cc'] })).toMatchObject({ field: 'questions[0].name' });
    const trusted = new Set(['questions[0].label']);
    expect(checkEventTypeEdit({ questions: [q({ label: 'See https://x.test' })] }, { existingQuestionNames: ['q1'], trusted })).toBeNull();
  });

  it('makes a slug from a title, and a revision that follows the content, not its key order', () => {
    expect(slugFromTitle('Café con Leche!')).toBe('cafe-con-leche');
    expect(slugFromTitle('***')).toBe('event');
    const base = {
      title: 'A', description: null, lengthMinutes: 30, location: null, bookingFields: [{ name: 'a', type: 'text' }],
      hidden: false, minimumBookingNotice: 0, requiresConfirmation: false, bookingWindowDays: null,
    };
    expect(eventTypeRevision(base)).toBe(eventTypeRevision({ ...base, bookingFields: [{ type: 'text', name: 'a' }] }));
    for (const change of [{ bookingFields: [{ name: 'b', type: 'text' }] }, { requiresConfirmation: true }, { bookingWindowDays: 30 }])
      expect(eventTypeRevision(base), JSON.stringify(change)).not.toBe(eventTypeRevision({ ...base, ...change }));
  });
});
