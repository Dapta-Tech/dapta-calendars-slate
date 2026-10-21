import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import type { EventReminder } from '@slate/types';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import {
  assertCalendarTemplates,
  assertReminderTemplates,
  assertTemplates,
  type TemplateFieldIssue,
} from './template-validation';

type Refusal = { error: string; message: string; issues: TemplateFieldIssue[] };

/** The 400 body a refused save answers with. */
function refusal(run: () => void): Refusal {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Refusal;
  }
  throw new Error('expected the save to be refused');
}

async function refusalOf(run: Promise<unknown>): Promise<Refusal> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Refusal;
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

const INVITEE_EMAIL = { context: 'email', audience: 'invitee', locale: 'en' } as const;

describe('assertTemplates (save-time gate)', () => {
  it('accepts clean copy, empty fields and form answers on an account-wide email', () => {
    expect(() =>
      assertTemplates(INVITEE_EMAIL, [
        { field: 'subject', label: 'Subject', text: 'Hi {{first_name | "there"}}' },
        { field: 'body', label: 'Body', text: '{{#if form.company}}At {{form.company}}{{/if}} {{manage_url}}' },
        { field: 'body', label: 'Unset', text: undefined },
        { field: 'body', label: 'Default', text: null },
      ]),
    ).not.toThrow();
  });

  it('refuses an unknown variable and a broken block, naming each with its offsets', () => {
    const body = 'Hi {{atendee_name}}\n{{#if form.x}}open';
    const r = refusal(() => assertTemplates(INVITEE_EMAIL, [{ field: 'body', label: 'Body', text: body }]));
    expect(r.error).toBe('INVALID_TEMPLATE');
    expect(r.message).toBe('Body: {{atendee_name}} is not a variable. Pick one from the list.');
    expect(r.issues.map((i) => i.code)).toEqual(['unknown_variable', 'unclosed_block']);
    expect(r.issues[0]).toMatchObject({ field: 'body', label: 'Body', token: '{{atendee_name}}' });
    expect(body.slice(r.issues[0]!.start, r.issues[0]!.end)).toBe('{{atendee_name}}');
  });

  it('writes the messages in the host language', () => {
    const r = refusal(() =>
      assertTemplates({ ...INVITEE_EMAIL, locale: 'es' }, [{ field: 'subject', label: 'Asunto', text: '{{nope}}' }]),
    );
    expect(r.message).toBe('Asunto: {{nope}} no es una variable. Elige una de la lista.');
  });

  it('keeps the other guests out of invitee copy, and allows them in the host copy', () => {
    const text = 'With {{guests}}';
    const r = refusal(() => assertTemplates(INVITEE_EMAIL, [{ field: 'body', label: 'Body', text }]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'host_only', token: '{{guests}}' })]);
    expect(() =>
      assertTemplates({ ...INVITEE_EMAIL, audience: 'host' }, [{ field: 'body', label: 'Body', text }]),
    ).not.toThrow();
  });

  it('refuses a variable the context cannot read', () => {
    const r = refusal(() =>
      assertTemplates({ ...INVITEE_EMAIL, context: 'title' }, [{ field: 'subject', label: 'Title', text: 'Call {{manage_url}}' }]),
    );
    expect(r.issues).toEqual([expect.objectContaining({ code: 'not_available' })]);
  });

  it('lets a text already stored through unchanged, line endings aside, and checks it once edited', () => {
    const stored = 'Old copy {{bogus}}\r\nsecond line';
    const pass = (text: string) => () =>
      assertTemplates(INVITEE_EMAIL, [{ field: 'body', label: 'Body', text, previous: stored }]);
    expect(pass(stored)).not.toThrow();
    expect(pass('Old copy {{bogus}}\nsecond line')).not.toThrow();
    expect(pass(`${stored}!`)).toThrow(BadRequestException);
  });
});

describe('assertReminderTemplates', () => {
  it('numbers reminders as the editor lists them, the follow-up apart, and names the reminder', () => {
    const rows = [
      reminder({ id: 'a', body: 'ok {{attendee_name}}' }),
      reminder({ id: 'f', kind: 'follow_up', body: 'fine' }),
      reminder({ id: 'b', subject: '{{nope}}' }),
    ];
    const r = refusal(() => assertReminderTemplates(rows, [], 'en'));
    expect(r.message).toBe('Reminder 2 subject: {{nope}} is not a variable. Pick one from the list.');
    expect(r.issues[0]).toMatchObject({ field: 'subject', reminderId: 'b' });
    const follow = [reminder({ id: 'f', kind: 'follow_up', body: '{{/if}}' })];
    expect(refusal(() => assertReminderTemplates(follow, [], 'es')).message).toMatch(/^Seguimiento cuerpo: /);
  });

  it('treats reminder copy as invitee copy', () => {
    const rows = [reminder({ body: 'Also coming: {{guests}}' })];
    expect(refusal(() => assertReminderTemplates(rows, [], 'en')).issues[0]!.code).toBe('host_only');
  });

  it('never blocks a save that leaves a stored reminder as it was', () => {
    const stored = [reminder({ id: 'a', body: 'Legacy {{bogus}}' })];
    expect(() => assertReminderTemplates([...stored], stored, 'en')).not.toThrow();
    expect(() => assertReminderTemplates(undefined, stored, 'en')).not.toThrow();
    // The same text on a NEW reminder id is new copy, and is checked.
    expect(() => assertReminderTemplates([reminder({ id: 'z', body: 'Legacy {{bogus}}' })], stored, 'en')).toThrow(
      BadRequestException,
    );
  });
});

describe('assertCalendarTemplates', () => {
  it('accepts a title with the invitee name and a description built on answers', () => {
    expect(() =>
      assertCalendarTemplates(
        {
          calendarTitleTemplate: 'Reunión Felipe - {{name}}',
          calendarDescriptionTemplate: '{{#if form.company}}Company: {{form.company}}{{/if}}\n{{start_time_attendee}}',
        },
        null,
        'en',
      ),
    ).not.toThrow();
  });

  it('refuses what a calendar event cannot carry, naming the field', () => {
    const r = refusal(() =>
      assertCalendarTemplates(
        { calendarTitleTemplate: 'Call {{manage_url}}', calendarDescriptionTemplate: 'Others: {{guests}} {{nope}}' },
        null,
        'en',
      ),
    );
    expect(r.error).toBe('INVALID_TEMPLATE');
    expect(r.message).toBe('Calendar event title: {{manage_url}} is not available here.');
    expect(r.issues.map((i) => [i.field, i.code])).toEqual([
      ['calendarTitleTemplate', 'not_available'],
      ['calendarDescriptionTemplate', 'not_available'],
      ['calendarDescriptionTemplate', 'unknown_variable'],
    ]);
  });

  it('keeps the booking page link and the time variables of the description out of the title', () => {
    const r = refusal(() =>
      assertCalendarTemplates({ calendarTitleTemplate: '{{booking_link}} {{start_time_host}}' }, null, 'es'),
    );
    expect(r.issues.map((i) => i.code)).toEqual(['not_available', 'not_available']);
    expect(r.message).toBe('Título del evento en el calendario: {{booking_link}} no está disponible aquí.');
  });

  it('on an event with seats, refuses one invitee data, also when a save turns seats on', () => {
    const seated = refusal(() =>
      assertCalendarTemplates({ calendarTitleTemplate: 'Workshop {{name}}', seatsPerTimeSlot: 5 }, null, 'en'),
    );
    expect(seated.issues[0]).toMatchObject({ field: 'calendarTitleTemplate', code: 'per_invitee' });
    // Stored before, untouched by this save, and now shared by every seat.
    const stored = { calendarTitleTemplate: 'Call {{name}}', calendarDescriptionTemplate: '{{form.company}}', seatsPerTimeSlot: null };
    const turnedOn = refusal(() => assertCalendarTemplates({ seatsPerTimeSlot: 3 }, stored, 'en'));
    expect(turnedOn.issues.map((i) => [i.field, i.code])).toEqual([
      ['calendarTitleTemplate', 'per_invitee'],
      ['calendarDescriptionTemplate', 'per_invitee'],
    ]);
    // Seats off again, or a text with nothing personal: fine.
    expect(() => assertCalendarTemplates({ seatsPerTimeSlot: 1 }, stored, 'en')).not.toThrow();
    expect(() =>
      assertCalendarTemplates({ calendarTitleTemplate: 'Workshop with {{host_name}}', seatsPerTimeSlot: 3 }, null, 'en'),
    ).not.toThrow();
  });

  it('lets stored text through unchanged, checks an edit, and treats null or blank as none', () => {
    const stored = { calendarTitleTemplate: 'Old {{bogus}}', calendarDescriptionTemplate: null, seatsPerTimeSlot: null };
    expect(() => assertCalendarTemplates({}, stored, 'en')).not.toThrow();
    expect(() => assertCalendarTemplates({ calendarTitleTemplate: 'Old {{bogus}}' }, stored, 'en')).not.toThrow();
    expect(() => assertCalendarTemplates({ calendarTitleTemplate: null, calendarDescriptionTemplate: '  ' }, stored, 'en')).not.toThrow();
    expect(refusal(() => assertCalendarTemplates({ calendarTitleTemplate: 'New {{bogus}}' }, stored, 'en')).issues).toHaveLength(1);
  });
});

describe('event type saves run the gate (real controller)', () => {
  const REQ: ReqLike = { headers: {} };
  let db: Db;
  let crud: AdminCrudController;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    await db.run(sql`UPDATE member SET locale='es' WHERE id=${m.id}`);
    const principal: HostPrincipal = { accountId: m.account_id, memberId: m.id, role: 'owner' };
    const auth = { resolveHost: () => Promise.resolve(principal) };
    crud = new AdminCrudController(db, auth as unknown as AuthService);
  });

  it('a create with reminder copy that cannot render is refused, in the host language', async () => {
    const r = await refusalOf(
      crud.createEventType(REQ, {
        slug: 'tpl-call',
        title: 'Tpl Call',
        lengthMinutes: 30,
        reminders: [reminder({ id: 'r1', body: 'Hola {{nombre}}' })],
      }),
    );
    expect(r.message).toBe('Recordatorio 1 cuerpo: {{nombre}} no es una variable. Elige una de la lista.');
    expect(r.issues[0]).toMatchObject({ reminderId: 'r1', field: 'body', code: 'unknown_variable' });
  });

  it('an update keeps working around copy stored before the gate, and checks what it changes', async () => {
    const created = await crud.createEventType(REQ, { slug: 'tpl-old', title: 'Old', lengthMinutes: 30 });
    // Copy saved before this check existed, written straight to the row.
    const legacy = [reminder({ id: 'r1', body: 'Legacy {{bogus}}' })];
    await db.run(sql`UPDATE event_type SET reminders=${JSON.stringify(legacy)} WHERE id=${created.id}`);
    const renamed = await crud.updateEventType(REQ, created.id, { title: 'Renamed', reminders: legacy });
    expect(renamed.title).toBe('Renamed');
    const r = await refusalOf(
      crud.updateEventType(REQ, created.id, { reminders: [reminder({ id: 'r1', body: 'Legacy {{bogus}} edited' })] }),
    );
    expect(r.issues[0]).toMatchObject({ reminderId: 'r1', code: 'unknown_variable' });
  });

  it('stores calendar templates that render, refuses one that cannot, and re-checks on seats', async () => {
    const created = await crud.createEventType(REQ, {
      slug: 'cal-tpl',
      title: 'Cal',
      lengthMinutes: 30,
      calendarTitleTemplate: 'Reunión Alex - {{name}}',
      calendarDescriptionTemplate: 'Empresa: {{form.company}}',
    });
    expect(created).toMatchObject({
      calendarTitleTemplate: 'Reunión Alex - {{name}}',
      calendarDescriptionTemplate: 'Empresa: {{form.company}}',
    });
    const bad = await refusalOf(
      crud.updateEventType(REQ, created.id, { calendarDescriptionTemplate: 'Gestionar: {{manage_url}}' }),
    );
    expect(bad.message).toBe('Descripción del evento en el calendario: {{manage_url}} no está disponible aquí.');
    const seats = await refusalOf(crud.updateEventType(REQ, created.id, { seatsPerTimeSlot: 4 }));
    expect(seats.issues.map((i) => i.code)).toEqual(['per_invitee', 'per_invitee']);
    expect(seats.message).toContain('todos los que reservan un cupo');
    // Clearing them is always allowed, and then seats can go on.
    const cleared = await crud.updateEventType(REQ, created.id, {
      calendarTitleTemplate: null,
      calendarDescriptionTemplate: '',
      seatsPerTimeSlot: 4,
    });
    expect(cleared).toMatchObject({ calendarTitleTemplate: null, calendarDescriptionTemplate: null, seatsPerTimeSlot: 4 });
  });
});
