import { BadRequestException } from '@nestjs/common';
import {
  templateErrors,
  templateIssueMessage,
  type TemplateAudience,
  type TemplateContext,
  type TemplateLocale,
  type ValidateOptions,
} from '@slate/engine';
import type { EventReminder } from '@slate/types';

/** The fields a template can sit in: an email's two, and the calendar event's two on an event type. */
export type TemplateFieldName = 'subject' | 'body' | 'calendarTitleTemplate' | 'calendarDescriptionTemplate';

/** One host-written template field on a save, with what is stored for it now. */
export interface TemplateField {
  field: TemplateFieldName;
  /** The reminder this field belongs to, on an event type save. */
  reminderId?: string;
  /** How the message names the field ("Subject", "Reminder 2 body"), in the host's language. */
  label: string;
  text: string | null | undefined;
  /** The stored text this save replaces; absent on a create. */
  previous?: string | null;
}

/**
 * A refused template, as the 400 body lists it and as the preview returns it:
 * the field, the problem and its offsets into that field's text, and a message
 * in the host's language.
 */
export interface TemplateFieldIssue {
  field: TemplateFieldName;
  reminderId?: string;
  label: string;
  code: string;
  token: string;
  start: number;
  end: number;
  message: string;
}

/** The text as it is compared with what is stored: line endings do not count. */
function sameText(a: string, b: string | null | undefined): boolean {
  return b != null && a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
}

/**
 * The save-time gate for host-written templates: fail closed at save, so a
 * typo like `{{atendee_name}}` or a block missing its `{{/if}}` is caught while
 * the host is still looking at it, not discovered in an invitee's inbox. Only
 * errors block; a question the event does not ask is the editor's warning.
 *
 * A text equal to what is already stored passes whatever it holds. Copy saved
 * before this gate existed keeps rendering exactly as it did (the renderer
 * fails soft), and the event editor, which sends every reminder on every save,
 * never blocks a host who only changed the title.
 */
export function assertTemplates(
  target: { context: TemplateContext; audience: TemplateAudience; locale: TemplateLocale },
  fields: readonly TemplateField[],
): void {
  const issues: TemplateFieldIssue[] = [];
  for (const f of fields) {
    if (!f.text || sameText(f.text, f.previous)) continue;
    issues.push(...fieldIssues(f, { context: target.context, audience: target.audience }, target.locale));
  }
  refuse(issues);
}

/** One field's blocking issues, as the 400 body lists them. */
function fieldIssues(f: TemplateField, opts: ValidateOptions, locale: TemplateLocale): TemplateFieldIssue[] {
  return templateErrors(f.text ?? '', opts).map((i) => ({
    field: f.field,
    ...(f.reminderId ? { reminderId: f.reminderId } : {}),
    label: f.label,
    code: i.code,
    token: i.token,
    start: i.start,
    end: i.end,
    message: templateIssueMessage(i, locale),
  }));
}

/** Throw the 400 for a save with refused templates; the message names the first. */
function refuse(issues: readonly TemplateFieldIssue[]): void {
  const first = issues[0];
  if (!first) return;
  throw new BadRequestException({ error: 'INVALID_TEMPLATE', message: `${first.label}: ${first.message}`, issues });
}

const CALENDAR_LABELS: Record<TemplateLocale, Record<'calendarTitleTemplate' | 'calendarDescriptionTemplate', string>> = {
  en: { calendarTitleTemplate: 'Calendar event title', calendarDescriptionTemplate: 'Calendar event description' },
  es: {
    calendarTitleTemplate: 'Título del evento en el calendario',
    calendarDescriptionTemplate: 'Descripción del evento en el calendario',
  },
};

/** An event type's calendar text: the two templates and whether it has seats. */
export interface CalendarTemplateState {
  calendarTitleTemplate?: string | null;
  calendarDescriptionTemplate?: string | null;
  seatsPerTimeSlot?: number | null;
}

/**
 * The calendar event's title and description templates on an event type save.
 * The event is the host's, and every invitee on it is a guest, so it is
 * checked for the invitee: nothing private to the host. On an event with
 * seats, one invitee's data is refused too (`seated`), since every seat-taker
 * shares the one event; a save that turns seats on checks the templates it
 * leaves behind for that reason, even if it did not touch them. Otherwise a
 * text equal to what is stored passes, as every template does.
 *
 * `input` is the save (omitted fields unchanged); `stored` is the event type as
 * it is now, absent on a create. A question the event does not ask is only the
 * editor's warning: answers are matched by name and a question can be renamed.
 */
export function assertCalendarTemplates(
  input: CalendarTemplateState,
  stored: CalendarTemplateState | null,
  locale: TemplateLocale,
): void {
  const seats = input.seatsPerTimeSlot !== undefined ? input.seatsPerTimeSlot : stored?.seatsPerTimeSlot;
  const seated = (seats ?? 1) > 1;
  const seatsTurnedOn = seated && (stored?.seatsPerTimeSlot ?? 1) <= 1;
  const issues: TemplateFieldIssue[] = [];
  for (const field of ['calendarTitleTemplate', 'calendarDescriptionTemplate'] as const) {
    const previous = stored?.[field] ?? null;
    const text = input[field] !== undefined ? input[field] : previous;
    if (!text?.trim()) continue;
    if (!seatsTurnedOn && sameText(text, previous)) continue;
    const context = field === 'calendarTitleTemplate' ? 'title' : 'description';
    issues.push(
      ...fieldIssues(
        { field, label: CALENDAR_LABELS[locale][field], text },
        { context, audience: 'invitee', seated },
        locale,
      ),
    );
  }
  refuse(issues);
}

const LABELS: Record<TemplateLocale, { subject: string; body: string; reminder: string; followUp: string }> = {
  en: { subject: 'subject', body: 'body', reminder: 'Reminder', followUp: 'Follow-up' },
  es: { subject: 'asunto', body: 'cuerpo', reminder: 'Recordatorio', followUp: 'Seguimiento' },
};

/** "Subject" / "Asunto": a field of an account-wide template, as its message names it. */
export function templateFieldLabel(field: 'subject' | 'body', locale: TemplateLocale): string {
  const word = LABELS[locale][field];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Reminder copy is invitee email copy: refuse a subject or body that cannot
 * render as written. A text already stored on the same reminder passes
 * unchanged (see `assertTemplates`), since the editor sends every reminder on
 * every save. Reminders are numbered as the editor lists them, the follow-up
 * apart.
 */
export function assertReminderTemplates(
  rows: readonly EventReminder[] | undefined,
  stored: readonly EventReminder[],
  locale: TemplateLocale,
): void {
  if (!rows) return;
  const l = LABELS[locale];
  const fields: TemplateField[] = [];
  let reminders = 0;
  for (const r of rows) {
    if (r.kind === 'reminder') reminders += 1;
    const name = r.kind === 'follow_up' ? l.followUp : `${l.reminder} ${reminders}`;
    const before = stored.find((s) => s.id === r.id);
    for (const field of ['subject', 'body'] as const) {
      fields.push({
        field,
        reminderId: r.id,
        label: `${name} ${l[field]}`,
        text: r[field],
        previous: before?.[field],
      });
    }
  }
  assertTemplates({ context: 'email', audience: 'invitee', locale }, fields);
}
