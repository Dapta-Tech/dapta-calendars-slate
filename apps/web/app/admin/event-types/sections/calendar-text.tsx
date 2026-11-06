'use client';

import { useRef, type RefObject } from 'react';
import {
  TEMPLATE_VARIABLE_GROUPS,
  formVariable,
  renderTemplate,
  variablesFor,
  type TemplateContext,
  type TemplateValues,
} from '@slate/engine';
import { MAX_CALENDAR_DESCRIPTION_TEMPLATE, MAX_CALENDAR_TITLE_TEMPLATE } from '@slate/types';
import { errorAria, inputCls, type EventTypeMessages } from './shared';

export interface CalendarTextQuestion {
  name: string;
  label: string;
}

/** Field ids for the two templates (the editor's guidance focuses them). */
export const CALENDAR_TEXT_IDS = { title: 'et-calendar-title', description: 'et-calendar-description' } as const;

/**
 * The example a template renders to: the catalog's own sample for each
 * built-in variable (what the API's previews use), and each booking-form
 * answer shown as its question in brackets.
 */
function sampleValues(locale: 'en' | 'es', eventTitle: string, questions: readonly CalendarTextQuestion[]): TemplateValues {
  const values: Record<string, string> = {};
  for (const d of variablesFor('email')) values[d.name] = d.sample[locale];
  if (eventTitle.trim()) {
    values.event_title = eventTitle.trim();
    values.event_name = eventTitle.trim();
  }
  for (const q of questions) values[formVariable(q.name)] = `[${q.label || q.name}]`;
  return values;
}

/** Insert `{{token}}` at the caret (or over the selection) of a text field. */
function insertAt(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  current: string,
  token: string,
  onChange: (next: string) => void,
) {
  const el = ref.current;
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? start;
  const text = `{{${token}}}`;
  onChange(`${current.slice(0, start)}${text}${current.slice(end)}`);
  requestAnimationFrame(() => {
    el?.focus();
    const at = start + text.length;
    el?.setSelectionRange(at, at);
  });
}

/** The "Insert variable" menu: the form's answers first, then the catalog by group. */
function InsertVariable({
  context,
  questions,
  seated,
  locale,
  onPick,
  m,
  label,
}: {
  context: TemplateContext;
  questions: readonly CalendarTextQuestion[];
  seated: boolean;
  locale: 'en' | 'es';
  onPick: (token: string) => void;
  m: EventTypeMessages['editor']['calendarText'];
  /** Which field it inserts into, for assistive technology. */
  label: string;
}) {
  // An event with seats shares ONE calendar event: no one invitee's data in it.
  const vars = variablesFor(context, 'invitee').filter((d) => !(seated && d.perInvitee));
  return (
    <select
      value=""
      aria-label={`${m.insert} — ${label}`}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      className="cursor-pointer self-start rounded-md border border-input bg-background px-inline py-tight text-sm text-muted-foreground"
    >
      <option value="">+ {m.insert}</option>
      {!seated ? (
        <optgroup label={m.groupForm}>
          {questions.length ? (
            questions.map((q) => (
              <option key={q.name} value={formVariable(q.name)}>
                {q.label || q.name}
              </option>
            ))
          ) : (
            <option disabled value="-">
              {m.noQuestions}
            </option>
          )}
        </optgroup>
      ) : null}
      {TEMPLATE_VARIABLE_GROUPS.map((g) => {
        const inGroup = vars.filter((d) => d.group === g);
        return inGroup.length ? (
          <optgroup key={g} label={m.groups[g]}>
            {inGroup.map((d) => (
              <option key={d.name} value={d.name}>
                {d.label[locale]}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/**
 * "In the calendar": what the calendar event is called and what it says, as
 * templates that can carry who booked and what they answered
 * (`Intro call – {{attendee_name}} ({{form.company}})`). Rendered once per
 * booking by the API; empty keeps the event's own title and no description.
 * Each field shows what it renders to with sample values.
 */
export function CalendarTextSection({
  title,
  description,
  onTitle,
  onDescription,
  onTitleBlur,
  onDescriptionBlur,
  titleError,
  descriptionError,
  eventTitle,
  questions,
  seated,
  locale,
  m,
}: {
  title: string;
  description: string;
  onTitle: (v: string) => void;
  onDescription: (v: string) => void;
  onTitleBlur: () => void;
  onDescriptionBlur: () => void;
  titleError: string | null;
  descriptionError: string | null;
  eventTitle: string;
  questions: readonly CalendarTextQuestion[];
  seated: boolean;
  locale: 'en' | 'es';
  m: EventTypeMessages['editor']['calendarText'];
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const values = sampleValues(locale, eventTitle, questions);
  const titleExample = title.trim() ? renderTemplate(title, values, { mode: 'line', locale }) : '';
  const descriptionExample = description.trim() ? renderTemplate(description, values, { mode: 'text', locale }) : '';
  const titleErrorId = `${CALENDAR_TEXT_IDS.title}-error`;
  const descriptionErrorId = `${CALENDAR_TEXT_IDS.description}-error`;

  return (
    <div className="flex flex-col gap-field">
      {seated ? <p className="text-xs text-muted-foreground">{m.seatedNote}</p> : null}

      <div className="flex flex-col gap-tight">
        <label htmlFor={CALENDAR_TEXT_IDS.title} className="text-sm text-muted-foreground">
          {m.titleLabel}
        </label>
        <input
          id={CALENDAR_TEXT_IDS.title}
          ref={titleRef}
          value={title}
          maxLength={MAX_CALENDAR_TITLE_TEMPLATE}
          placeholder={m.titlePlaceholder}
          onChange={(e) => onTitle(e.target.value)}
          onBlur={onTitleBlur}
          className={inputCls}
          {...errorAria(titleError, titleErrorId)}
        />
        <InsertVariable
          context="title"
          questions={questions}
          seated={seated}
          locale={locale}
          onPick={(token) => insertAt(titleRef, title, token, onTitle)}
          m={m}
          label={m.titleLabel}
        />
        {titleError ? (
          <p id={titleErrorId} className="text-xs text-destructive">
            {titleError}
          </p>
        ) : null}
        {titleExample ? (
          <p className="text-xs text-foreground" data-testid="et-calendar-title-example">
            {m.preview.replace('{text}', titleExample)}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{m.titleHint}</p>
      </div>

      <div className="flex flex-col gap-tight">
        <label htmlFor={CALENDAR_TEXT_IDS.description} className="text-sm text-muted-foreground">
          {m.descriptionLabel}
        </label>
        <textarea
          id={CALENDAR_TEXT_IDS.description}
          ref={descriptionRef}
          value={description}
          rows={3}
          maxLength={MAX_CALENDAR_DESCRIPTION_TEMPLATE}
          onChange={(e) => onDescription(e.target.value)}
          onBlur={onDescriptionBlur}
          className={inputCls}
          {...errorAria(descriptionError, descriptionErrorId)}
        />
        <InsertVariable
          context="description"
          questions={questions}
          seated={seated}
          locale={locale}
          onPick={(token) => insertAt(descriptionRef, description, token, onDescription)}
          m={m}
          label={m.descriptionLabel}
        />
        {descriptionError ? (
          <p id={descriptionErrorId} className="text-xs text-destructive">
            {descriptionError}
          </p>
        ) : null}
        {descriptionExample ? (
          <p className="whitespace-pre-line text-xs text-foreground" data-testid="et-calendar-description-example">
            {m.preview.replace('{text}', descriptionExample)}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{m.descriptionHint}</p>
      </div>
    </div>
  );
}
