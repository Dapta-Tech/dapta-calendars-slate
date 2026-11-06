'use client';

import { useId, useRef, useState, type FocusEvent } from 'react';
import {
  TEMPLATE_VARIABLE_GROUPS,
  formVariable,
  isFormVariable,
  renderTemplate,
  templateVariable,
  variablesFor,
  type TemplateContext,
  type TemplateValues,
} from '@slate/engine';
import { MAX_CALENDAR_DESCRIPTION_TEMPLATE, MAX_CALENDAR_TITLE_TEMPLATE } from '@slate/types';
import { cn } from '@/lib/cn';
import type { EventTypeMessages } from './shared';
import { TemplateField, chipClass, type ChipLook, type TemplateFieldHandle } from './template-field';

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

/**
 * "In the calendar": what the calendar event is called and what it says, as
 * templates that can carry who booked and what they answered. Variables are
 * chips: dragged from the palette into either field, clicked to add at the
 * caret of the field last used, or typed as `{{name}}`. Rendered once per
 * booking by the API; empty keeps the event's own title and no description.
 * Each field shows what it renders to with sample values.
 */
/**
 * Scroll so the focused field sits just under the editor's sticky header with
 * the palette below it in view: the chips are what the host reaches for next.
 * Only ever scrolls down to make room, and never past the field itself.
 */
function revealWithPalette(field: HTMLElement | null, palette: HTMLElement | null) {
  if (!field || !palette) return;
  const header = field.closest('form')?.firstElementChild?.getBoundingClientRect().bottom ?? 0;
  const margin = 16;
  const overflow = palette.getBoundingClientRect().bottom + margin - window.innerHeight;
  const room = field.getBoundingClientRect().top - (header + margin);
  const by = Math.min(overflow, room);
  if (by > 0) window.scrollBy({ top: by, behavior: 'smooth' });
}

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
  const titleRef = useRef<TemplateFieldHandle>(null);
  const descriptionRef = useRef<TemplateFieldHandle>(null);
  // The palette follows the field last used: the title allows fewer variables.
  const [target, setTarget] = useState<TemplateContext>('title');
  // A template field has focus: the palette is where its variables come from,
  // so it lights up, and the page scrolls so it is in view under the field.
  const [active, setActive] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const onFieldFocus = (context: TemplateContext, fieldId: string) => {
    setTarget(context);
    setActive(true);
    revealWithPalette(document.getElementById(fieldId), paletteRef.current);
  };
  const onFieldBlur = (e: FocusEvent<HTMLDivElement>, blur: () => void) => {
    // Clicking a chip moves focus into the palette for a moment: stay lit.
    if (!paletteRef.current?.contains(e.relatedTarget as Node | null)) setActive(false);
    blur();
  };
  const ids = { titleLabel: useId(), descriptionLabel: useId(), palette: useId() };

  const look = (token: string): ChipLook => {
    if (isFormVariable(token)) {
      const q = questions.find((x) => formVariable(x.name) === token);
      return { label: q ? q.label || q.name : token.slice(5), kind: q ? 'answer' : 'unknown' };
    }
    const d = templateVariable(token);
    return d ? { label: d.label[locale], kind: 'builtin' } : { label: token, kind: 'unknown' };
  };

  // An event with seats shares ONE calendar event: no one invitee's data in it.
  const builtins = variablesFor(target, 'invitee').filter((d) => !(seated && d.perInvitee));
  const values = sampleValues(locale, eventTitle, questions);
  const titleExample = title.trim() ? renderTemplate(title, values, { mode: 'line', locale }) : '';
  const descriptionExample = description.trim() ? renderTemplate(description, values, { mode: 'text', locale }) : '';
  const titleErrorId = `${CALENDAR_TEXT_IDS.title}-error`;
  const descriptionErrorId = `${CALENDAR_TEXT_IDS.description}-error`;

  const chip = (token: string, label: string, kind: ChipLook['kind']) => (
    <button
      key={token}
      type="button"
      draggable
      data-token={token}
      onDragStart={(e) => {
        // Dropped as text, which the field turns into a chip where it lands.
        e.dataTransfer.setData('text/plain', `{{${token}}}`);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => (target === 'title' ? titleRef : descriptionRef).current?.insert(token)}
      className={cn(chipClass(kind), 'cursor-grab active:cursor-grabbing hover:border-foreground/40')}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-field">
      {seated ? <p className="text-xs text-muted-foreground">{m.seatedNote}</p> : null}

      <div className="flex flex-col gap-tight">
        <span id={ids.titleLabel} className="text-sm text-muted-foreground">
          {m.titleLabel}
        </span>
        <TemplateField
          id={CALENDAR_TEXT_IDS.title}
          ref={titleRef}
          value={title}
          onChange={onTitle}
          onBlur={(e) => onFieldBlur(e, onTitleBlur)}
          look={look}
          maxLength={MAX_CALENDAR_TITLE_TEMPLATE}
          placeholder={m.titlePlaceholder}
          labelledBy={ids.titleLabel}
          describedBy={titleError ? titleErrorId : undefined}
          invalid={!!titleError}
          onFocus={() => onFieldFocus('title', CALENDAR_TEXT_IDS.title)}
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
        <span id={ids.descriptionLabel} className="text-sm text-muted-foreground">
          {m.descriptionLabel}
        </span>
        <TemplateField
          id={CALENDAR_TEXT_IDS.description}
          ref={descriptionRef}
          value={description}
          onChange={onDescription}
          onBlur={(e) => onFieldBlur(e, onDescriptionBlur)}
          look={look}
          multiline
          maxLength={MAX_CALENDAR_DESCRIPTION_TEMPLATE}
          labelledBy={ids.descriptionLabel}
          describedBy={descriptionError ? descriptionErrorId : undefined}
          invalid={!!descriptionError}
          onFocus={() => onFieldFocus('description', CALENDAR_TEXT_IDS.description)}
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

      <div
        id={ids.palette}
        ref={paletteRef}
        data-testid="et-variable-palette"
        data-active={active || undefined}
        className={cn(
          'flex flex-col gap-inline rounded-md border border-dashed border-border bg-background/40 p-card transition-colors',
          active && 'palette-pulse',
        )}
      >
        <p className="text-xs text-muted-foreground">{m.paletteHint}</p>
        {!seated ? (
          <div className="flex flex-wrap items-center gap-tight">
            <span className="mr-tight text-xs font-medium text-muted-foreground">{m.groupForm}</span>
            {questions.length ? (
              questions.map((q) => chip(formVariable(q.name), q.label || q.name, 'answer'))
            ) : (
              <span className="text-xs text-muted-foreground">{m.noQuestions}</span>
            )}
          </div>
        ) : null}
        {TEMPLATE_VARIABLE_GROUPS.map((g) => {
          const inGroup = builtins.filter((d) => d.group === g);
          return inGroup.length ? (
            <div key={g} className="flex flex-wrap items-center gap-tight">
              <span className="mr-tight text-xs font-medium text-muted-foreground">{m.groups[g]}</span>
              {inGroup.map((d) => chip(d.name, d.label[locale], 'builtin'))}
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}
