'use client';

import { useMemo, useRef } from 'react';
import {
  MAX_REMINDERS_PER_EVENT,
  MAX_REMINDER_BODY,
  MAX_REMINDER_LEAD_MINUTES,
  MAX_REMINDER_SUBJECT,
  MIN_REMINDER_LEAD_MINUTES,
  type EventReminder,
} from '@slate/types';
import { Checkbox } from '@/components/ui/checkbox';
import { EventTypeMessages } from './shared';
import { ReminderEmailPreview, type ReminderPreviewContext } from './reminder-email-preview';

/** What a reminder needs to preview its email. */
export interface ReminderPreviewProps {
  context: ReminderPreviewContext;
  m: EventTypeMessages['editor']['preview'];
}

export type ReminderMessages = EventTypeMessages['reminders'];

/** The built-ins a reminder may quote, mirroring `TEMPLATE_VARIABLES`. */
export const REMINDER_VARIABLES = [
  'attendee_name',
  'attendee_email',
  'host_name',
  'event_title',
  'start_time',
  'end_time',
  'location',
  // The meeting link (C2 #85), resolved at delivery — the one variable that is
  // not snapshotted with the rest. It belongs in reminder copy more than
  // anywhere: a nudge an hour before the call is exactly when someone wants it.
  'meeting_url',
  'manage_url',
  'reminder_lead',
  'booking_link',
];

export const FORM_TOKEN_RE = /\{\{\s*form\.([A-Za-z0-9_]+)\s*\}\}/g;

export type LeadUnit = 'minutes' | 'hours' | 'days';

/** Show a lead in the largest whole unit it fits — 1440 reads as "1 day". */
export function splitLead(minutes: number): { value: number; unit: LeadUnit } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export function joinLead(value: number, unit: LeadUnit): number {
  const factor = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const minutes = Math.round(value * factor);
  return Math.min(Math.max(minutes, MIN_REMINDER_LEAD_MINUTES), MAX_REMINDER_LEAD_MINUTES);
}

export function newReminderId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One reminder row: its own switch, its own lead, its own subject and body
 * (#68 decision 1). The variable chips insert into whichever of the two text
 * fields was last focused — a raw text box beside a list of variable names is
 * a gap, not a feature.
 */
export function ReminderCard({
  row,
  onChange,
  onRemove,
  fieldNames,
  m,
  preview,
}: {
  row: EventReminder;
  onChange: (patch: Partial<EventReminder>) => void;
  onRemove?: () => void;
  fieldNames: string[];
  m: ReminderMessages;
  /** The editor's draft and copy for "Preview email"; absent, no preview. */
  preview?: ReminderPreviewProps;
}) {
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<'subject' | 'body'>('body');
  const lead = splitLead(row.leadMinutes);

  const insert = (token: string) => {
    const el = lastFocused.current === 'subject' ? subjectRef.current : bodyRef.current;
    const current = (lastFocused.current === 'subject' ? row.subject : row.body) ?? '';
    const at = el?.selectionStart ?? current.length;
    const next = `${current.slice(0, at)}{{${token}}}${current.slice(el?.selectionEnd ?? at)}`;
    onChange(lastFocused.current === 'subject' ? { subject: next } : { body: next });
    // Put the caret after the inserted token rather than at the end.
    requestAnimationFrame(() => {
      const pos = at + token.length + 4;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="flex flex-col gap-inline rounded-md border border-border bg-background/40 p-field">
      <div className="flex flex-wrap items-center gap-inline">
        <label className="flex cursor-pointer items-center gap-inline text-sm">
          <Checkbox
            checked={row.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            aria-label={m.enabledLabel}
          />
          <span className="text-muted-foreground">{m.sendLabel}</span>
        </label>
        <input
          type="number"
          // The floor is 5 MINUTES, so it is only 5 in the minutes unit — an
          // input advertising min=1 that silently snaps to 5 is a small lie.
          min={lead.unit === 'minutes' ? MIN_REMINDER_LEAD_MINUTES : 1}
          max={lead.unit === 'days' ? 28 : lead.unit === 'hours' ? 672 : MAX_REMINDER_LEAD_MINUTES}
          value={lead.value}
          onChange={(e) => onChange({ leadMinutes: joinLead(Number(e.target.value) || 1, lead.unit) })}
          aria-label={`${m.sendLabel} — ${m.unitMinutes}/${m.unitHours}/${m.unitDays}`}
          className="w-20 rounded-md border border-input bg-background px-inline py-tight text-sm"
        />
        <select
          value={lead.unit}
          onChange={(e) => onChange({ leadMinutes: joinLead(lead.value, e.target.value as LeadUnit) })}
          aria-label={row.kind === 'follow_up' ? m.afterEnd : m.beforeStart}
          className="rounded-md border border-input bg-background px-inline py-tight text-sm"
        >
          <option value="minutes">{m.unitMinutes}</option>
          <option value="hours">{m.unitHours}</option>
          <option value="days">{m.unitDays}</option>
        </select>
        <span className="text-sm text-muted-foreground">
          {row.kind === 'follow_up' ? m.afterEnd : m.beforeStart}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={m.remove}
            className="ml-auto text-muted-foreground hover:text-destructive"
          >
            ×
          </button>
        ) : null}
      </div>

      <input
        id={`et-reminder-${row.id}-subject`}
        ref={subjectRef}
        value={row.subject ?? ''}
        onFocus={() => (lastFocused.current = 'subject')}
        onChange={(e) => onChange({ subject: e.target.value || null })}
        placeholder={m.subjectLabel}
        aria-label={m.subjectLabel}
        maxLength={MAX_REMINDER_SUBJECT}
        className="w-full rounded-md border border-input bg-background px-inline py-tight text-sm"
      />
      <textarea
        id={`et-reminder-${row.id}-body`}
        ref={bodyRef}
        value={row.body ?? ''}
        onFocus={() => (lastFocused.current = 'body')}
        onChange={(e) => onChange({ body: e.target.value || null })}
        placeholder={m.bodyLabel}
        aria-label={m.bodyLabel}
        // Stop at the contract's limit rather than letting the save come back
        // as a bare 400 from the other side of the wire.
        maxLength={MAX_REMINDER_BODY}
        rows={3}
        className="w-full rounded-md border border-input bg-background px-inline py-tight text-sm"
      />
      <p className="text-xs text-muted-foreground">{m.defaultCopyHint}</p>
      {preview ? <ReminderEmailPreview row={row} context={preview.context} m={preview.m} /> : null}

      <div className="flex flex-col gap-tight">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">{m.variablesLabel}</span>
        <div className="flex flex-wrap gap-tight">
          {REMINDER_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insert(v)}
              className="rounded border border-border px-inline py-tight font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <span className="mt-tight text-2xs uppercase tracking-wide text-muted-foreground">
          {m.formVariablesLabel}
        </span>
        {fieldNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">{m.noFormVariables}</p>
        ) : (
          <div className="flex flex-wrap gap-tight">
            {fieldNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => insert(`form.${name}`)}
                className="rounded border border-border px-inline py-tight font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary"
              >
                {`{{form.${name}}}`}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reminders + follow-up, owned by the event type (#68). The list is one array
 * with a `kind` discriminator: reminders fire before the start, the single
 * follow-up after the end, and both share the row shape and the same switch.
 */
export function RemindersSection({
  rows,
  setRows,
  fieldNames,
  m,
  preview,
}: {
  rows: EventReminder[];
  setRows: (fn: (rows: EventReminder[]) => EventReminder[]) => void;
  fieldNames: string[];
  m: ReminderMessages;
  preview?: ReminderPreviewProps;
}) {
  const reminders = rows.filter((r) => r.kind === 'reminder');
  const followUp = rows.find((r) => r.kind === 'follow_up');
  const patch = (id: string, p: Partial<EventReminder>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  // Dangling references warn, never block (#68 decision 3): renaming or
  // deleting a question leaves the variable rendering empty, which is a
  // surprise worth naming — not a reason to refuse the save.
  const dangling = useMemo(() => {
    const known = new Set(fieldNames);
    const found = new Set<string>();
    for (const r of rows) {
      for (const text of [r.subject ?? '', r.body ?? '']) {
        for (const match of text.matchAll(FORM_TOKEN_RE)) {
          if (!known.has(match[1]!)) found.add(match[1]!);
        }
      }
    }
    return [...found];
  }, [rows, fieldNames]);

  return (
    <div className="flex flex-col gap-inline">
      <span className="text-sm font-semibold text-muted-foreground">{m.sectionTitle}</span>
      <p className="text-xs text-muted-foreground">{m.sectionHint}</p>

      <span className="mt-tight text-xs font-medium text-muted-foreground">{m.beforeMeeting}</span>
      {reminders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.noReminders}</p>
      ) : (
        reminders.map((r) => (
          <ReminderCard
            key={r.id}
            row={r}
            fieldNames={fieldNames}
            m={m}
            preview={preview}
            onChange={(p) => patch(r.id, p)}
            onRemove={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
          />
        ))
      )}
      <div className="flex items-center gap-field">
        <button
          type="button"
          disabled={reminders.length >= MAX_REMINDERS_PER_EVENT}
          onClick={() =>
            setRows((rs) => [
              ...rs.filter((r) => r.kind === 'reminder'),
              { id: newReminderId(), kind: 'reminder', enabled: true, leadMinutes: 60, subject: null, body: null },
              ...rs.filter((r) => r.kind === 'follow_up'),
            ])
          }
          className="self-start rounded-md border border-border px-field py-tight text-sm text-muted-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
        >
          {m.addReminder}
        </button>
        {reminders.length >= MAX_REMINDERS_PER_EVENT ? (
          <span className="text-xs text-muted-foreground">
            {m.capReached.replace('{max}', String(MAX_REMINDERS_PER_EVENT))}
          </span>
        ) : null}
      </div>

      <span className="mt-inline text-xs font-medium text-muted-foreground">{m.afterMeeting}</span>
      <p className="text-xs text-muted-foreground">{m.followUpHint}</p>
      <ReminderCard
        // An event whose stored list carries no follow-up still shows one,
        // switched off — the control has to be reachable to be turned on.
        row={
          followUp ?? {
            id: 'follow-up',
            kind: 'follow_up',
            enabled: false,
            leadMinutes: 60,
            subject: null,
            body: null,
          }
        }
        fieldNames={fieldNames}
        m={m}
        preview={preview}
        onChange={(p) =>
          setRows((rs) =>
            rs.some((r) => r.kind === 'follow_up')
              ? rs.map((r) => (r.kind === 'follow_up' ? { ...r, ...p } : r))
              : [
                  ...rs,
                  {
                    id: newReminderId(),
                    kind: 'follow_up' as const,
                    enabled: false,
                    leadMinutes: 60,
                    subject: null,
                    body: null,
                    ...p,
                  },
                ],
          )
        }
      />

      {dangling.length > 0 ? (
        <p className="text-xs text-destructive" role="alert">
          {m.danglingWarn.replace('{tokens}', dangling.map((t) => `{{form.${t}}}`).join(', '))}
        </p>
      ) : null}
    </div>
  );
}
