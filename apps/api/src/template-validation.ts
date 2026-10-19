import { BadRequestException } from '@nestjs/common';
import { templateErrors, templateIssueMessage, type TemplateContext } from '@slate/engine';
import type { EventReminder } from '@slate/types';

/** One host-written template field on a save, with what is stored for it now. */
export interface TemplateField {
  /** How the message names the field ("Subject", "Reminder 2 body"). */
  label: string;
  text: string | null | undefined;
  /** The stored text this save replaces; absent on a create. */
  previous?: string | null;
}

/** A refused template, as the 400 body lists it (offsets point into `text`). */
export interface TemplateFieldIssue {
  field: string;
  code: string;
  token: string;
  start: number;
  end: number;
  message: string;
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
export function assertTemplates(context: TemplateContext, fields: readonly TemplateField[]): void {
  const issues: TemplateFieldIssue[] = [];
  for (const f of fields) {
    if (!f.text || f.text === f.previous) continue;
    for (const i of templateErrors(f.text, { context })) {
      issues.push({
        field: f.label,
        code: i.code,
        token: i.token,
        start: i.start,
        end: i.end,
        message: templateIssueMessage(i),
      });
    }
  }
  const first = issues[0];
  if (!first) return;
  throw new BadRequestException({ error: 'BAD_REQUEST', message: `${first.field}: ${first.message}`, issues });
}

/**
 * Reminder copy is email copy: refuse a subject or body that cannot render as
 * written. A text already stored on the same reminder passes unchanged (see
 * `assertTemplates`), since the editor sends every reminder on every save.
 */
export function assertReminderTemplates(
  rows: readonly EventReminder[] | undefined,
  stored: readonly EventReminder[],
): void {
  if (!rows) return;
  let n = 0;
  assertTemplates(
    'email',
    rows.flatMap((r) => {
      const before = stored.find((s) => s.id === r.id);
      const name = r.kind === 'follow_up' ? 'Follow-up' : `Reminder ${(n += 1)}`;
      return [
        { label: `${name} subject`, text: r.subject, previous: before?.subject },
        { label: `${name} body`, text: r.body, previous: before?.body },
      ];
    }),
  );
}
