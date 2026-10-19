import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { EventReminder } from '@slate/types';
import { assertReminderTemplates, assertTemplates } from './template-validation';

/** The 400 body a refused save answers with. */
function refusal(run: () => void): { message: string; issues: Array<Record<string, unknown>> } {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as { message: string; issues: Array<Record<string, unknown>> };
  }
  throw new Error('expected the save to be refused');
}

const reminder = (over: Partial<EventReminder>): EventReminder => ({
  id: 'r1',
  kind: 'reminder',
  enabled: true,
  leadMinutes: 60,
  subject: null,
  body: null,
  ...over,
});

describe('assertTemplates (save-time gate)', () => {
  it('accepts clean copy, empty fields and form answers on an account-wide email', () => {
    expect(() =>
      assertTemplates('email', [
        { label: 'Subject', text: 'Hi {{first_name | "there"}}' },
        { label: 'Body', text: '{{#if form.company}}At {{form.company}}{{/if}} {{manage_url}}' },
        { label: 'Other', text: null },
        { label: 'Unset', text: undefined },
      ]),
    ).not.toThrow();
  });

  it('refuses an unknown variable and a broken block, naming each with its offsets', () => {
    const body = 'Hi {{atendee_name}}\n{{#if form.x}}open';
    const r = refusal(() => assertTemplates('email', [{ label: 'Body', text: body }]));
    expect(r.message).toBe('Body: {{atendee_name}} is not a variable. Pick one from the list.');
    expect(r.issues.map((i) => i.code)).toEqual(['unknown_variable', 'unclosed_block']);
    const first = r.issues[0]!;
    expect(body.slice(first.start as number, first.end as number)).toBe('{{atendee_name}}');
  });

  it('refuses a variable the context cannot read', () => {
    const r = refusal(() => assertTemplates('title', [{ label: 'Title', text: 'Call {{manage_url}}' }]));
    expect(r.issues).toEqual([expect.objectContaining({ field: 'Title', code: 'not_available' })]);
  });

  it('lets a text already stored through unchanged, and checks it again once edited', () => {
    const stored = 'Old copy {{bogus}}';
    expect(() => assertTemplates('email', [{ label: 'Body', text: stored, previous: stored }])).not.toThrow();
    expect(() => assertTemplates('email', [{ label: 'Body', text: `${stored}!`, previous: stored }])).toThrow(
      BadRequestException,
    );
  });
});

describe('assertReminderTemplates', () => {
  it('numbers reminders apart from the follow-up in the message', () => {
    const rows = [
      reminder({ id: 'a', body: 'ok {{attendee_name}}' }),
      reminder({ id: 'f', kind: 'follow_up', body: 'fine' }),
      reminder({ id: 'b', subject: '{{nope}}' }),
    ];
    expect(refusal(() => assertReminderTemplates(rows, [])).message).toBe(
      'Reminder 2 subject: {{nope}} is not a variable. Pick one from the list.',
    );
    const follow = [reminder({ id: 'f', kind: 'follow_up', body: '{{/if}}' })];
    expect(refusal(() => assertReminderTemplates(follow, [])).message).toMatch(/^Follow-up body: /);
  });

  it('never blocks a save that leaves a stored reminder as it was', () => {
    const stored = [reminder({ id: 'a', body: 'Legacy {{bogus}}' })];
    expect(() => assertReminderTemplates([...stored], stored)).not.toThrow();
    expect(() => assertReminderTemplates(undefined, stored)).not.toThrow();
    // The same text on a NEW reminder id is new copy, and is checked.
    expect(() => assertReminderTemplates([reminder({ id: 'z', body: 'Legacy {{bogus}}' })], stored)).toThrow(
      BadRequestException,
    );
  });
});
