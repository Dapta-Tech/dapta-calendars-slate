'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { COUNTRIES, countryName, isReservedFieldName, type BookingMessages } from '@slate/shared';
import {
  LOCATION_KINDS,
  MAX_REMINDERS_PER_EVENT,
  MAX_REMINDER_BODY,
  MAX_REMINDER_LEAD_MINUTES,
  MAX_REMINDER_SUBJECT,
  MIN_REMINDER_LEAD_MINUTES,
  defaultEventReminders,
  type EventReminder,
  type LocationKind,
} from '@slate/types';
import type { Connection, EventType } from '@/lib/admin-api';
import { connectionDisplayLabel } from '@/lib/connection-label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { FormHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/toast';
import { saveEventTypeAction, type ActionResult, type EventTypePayload } from './actions';

type EventTypeMessages = BookingMessages['admin']['eventTypes'];

const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'checkbox', 'guests'];
const SCHEDULING_METHODS = ['round_robin', 'collective', 'fixed_round_robin'] as const;
type SchedulingMethod = (typeof SCHEDULING_METHODS)[number];

interface IntakeField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** Phone questions: country the selector starts on (QA4 fix 1b). */
  defaultCountry?: string;
}

interface HostRow {
  memberId: string;
  priority: number | null;
  weight: number | null;
  isFixed: boolean;
}

export interface TeamMemberOption {
  memberId: string;
  displayName: string | null;
}

type ReminderMessages = EventTypeMessages['reminders'];

/** The built-ins a reminder may quote, mirroring `TEMPLATE_VARIABLES`. */
const REMINDER_VARIABLES = [
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

const FORM_TOKEN_RE = /\{\{\s*form\.([A-Za-z0-9_]+)\s*\}\}/g;

type LeadUnit = 'minutes' | 'hours' | 'days';

/** Show a lead in the largest whole unit it fits — 1440 reads as "1 day". */
function splitLead(minutes: number): { value: number; unit: LeadUnit } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

function joinLead(value: number, unit: LeadUnit): number {
  const factor = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const minutes = Math.round(value * factor);
  return Math.min(Math.max(minutes, MIN_REMINDER_LEAD_MINUTES), MAX_REMINDER_LEAD_MINUTES);
}

function newReminderId(): string {
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
function ReminderCard({
  row,
  onChange,
  onRemove,
  fieldNames,
  m,
}: {
  row: EventReminder;
  onChange: (patch: Partial<EventReminder>) => void;
  onRemove?: () => void;
  fieldNames: string[];
  m: ReminderMessages;
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
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
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
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
        <select
          value={lead.unit}
          onChange={(e) => onChange({ leadMinutes: joinLead(lead.value, e.target.value as LeadUnit) })}
          aria-label={row.kind === 'follow_up' ? m.afterEnd : m.beforeStart}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
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
        ref={subjectRef}
        value={row.subject ?? ''}
        onFocus={() => (lastFocused.current = 'subject')}
        onChange={(e) => onChange({ subject: e.target.value || null })}
        placeholder={m.subjectLabel}
        aria-label={m.subjectLabel}
        maxLength={MAX_REMINDER_SUBJECT}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      />
      <textarea
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
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
      />
      <p className="text-xs text-muted-foreground">{m.defaultCopyHint}</p>

      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">{m.variablesLabel}</span>
        <div className="flex flex-wrap gap-1">
          {REMINDER_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insert(v)}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
        <span className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">
          {m.formVariablesLabel}
        </span>
        {fieldNames.length === 0 ? (
          <p className="text-xs text-muted-foreground">{m.noFormVariables}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {fieldNames.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => insert(`form.${name}`)}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary"
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
function RemindersSection({
  rows,
  setRows,
  fieldNames,
  m,
}: {
  rows: EventReminder[];
  setRows: (fn: (rows: EventReminder[]) => EventReminder[]) => void;
  fieldNames: string[];
  m: ReminderMessages;
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
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-muted-foreground">{m.sectionTitle}</span>
      <p className="text-xs text-muted-foreground">{m.sectionHint}</p>

      <span className="mt-1 text-xs font-medium text-muted-foreground">{m.beforeMeeting}</span>
      {reminders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{m.noReminders}</p>
      ) : (
        reminders.map((r) => (
          <ReminderCard
            key={r.id}
            row={r}
            fieldNames={fieldNames}
            m={m}
            onChange={(p) => patch(r.id, p)}
            onRemove={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
          />
        ))
      )}
      <div className="flex items-center gap-3">
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
          className="self-start rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
        >
          {m.addReminder}
        </button>
        {reminders.length >= MAX_REMINDERS_PER_EVENT ? (
          <span className="text-xs text-muted-foreground">
            {m.capReached.replace('{max}', String(MAX_REMINDERS_PER_EVENT))}
          </span>
        ) : null}
      </div>

      <span className="mt-2 text-xs font-medium text-muted-foreground">{m.afterMeeting}</span>
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

/**
 * PHASE 2 — the EDITABLE "Calendars for this event" section (personal events
 * only; team events keep no per-event calendar config — Phase 3, each host
 * has their own connection and a single line here would be misleading).
 * Replaces the old read-only calendar-link notice (Felipe: "cómo está el
 * calendario conectado al evento, esto no hace sentido") with per-connection
 * "check for conflicts" + a single "add events here" destination choice.
 * Gracefully degrades: 0 connections → the connect-a-calendar hint; 1
 * connection → shown alone (both toggles default on, same as before).
 */
function CalendarsForEventSection({
  connections,
  conflictIds,
  destinationId,
  onToggleConflict,
  onSetDestination,
  m,
}: {
  connections: Connection[];
  conflictIds: Set<string>;
  destinationId: string | null;
  onToggleConflict: (id: string) => void;
  onSetDestination: (id: string) => void;
  m: EventTypeMessages;
}) {
  if (connections.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-sm text-muted-foreground">
        {m.calendarLinkNone}{' '}
        <Link href="/admin/connections" className="font-medium text-primary underline underline-offset-4">
          {m.calendarLinkConnect} →
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-muted-foreground">{m.calendarsSectionTitle}</span>
        <Link
          href="/admin/connections"
          className="shrink-0 text-xs font-medium text-primary underline underline-offset-4"
        >
          {m.calendarsManageLink} →
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">{m.calendarsSectionHint}</p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
          <span className="flex-1" />
          <span className="w-28 text-center sm:w-32">{m.calendarsCheckConflicts}</span>
          <span className="w-28 text-center sm:w-32">{m.calendarsAddEventsHere}</span>
        </div>
        {connections.map((c) => {
          const label = connectionDisplayLabel(c);
          return (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                {label}
              </span>
              <label
                className="flex w-28 cursor-pointer justify-center sm:w-32"
                aria-label={`${label} — ${m.calendarsCheckConflicts}`}
              >
                <Checkbox checked={conflictIds.has(c.id)} onChange={() => onToggleConflict(c.id)} />
              </label>
              <label
                className="flex w-28 cursor-pointer justify-center sm:w-32"
                aria-label={`${label} — ${m.calendarsAddEventsHere}`}
              >
                <Radio
                  name="destinationCalendarId"
                  checked={destinationId === c.id}
                  onChange={() => onSetDestination(c.id)}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * WHERE the meeting happens: a location KIND plus, for the kinds that need one,
 * a detail. Each kind gets its own labelled input, so every shape a location can
 * take is reachable — a bare text box could only ever express "custom".
 *
 * `conferencing` is the one kind with no detail: the link is minted by the
 * calendar port when the booking is confirmed. Its display name is injected by
 * the deployment (ADR 0008) — this repo names no platform, so a bare fork shows
 * only the generic wording.
 */
function LocationField({
  kind,
  detail,
  onKind,
  onDetail,
  connections,
  m,
  locationLabels,
}: {
  kind: LocationKind | '';
  detail: string;
  onKind: (kind: LocationKind | '') => void;
  onDetail: (detail: string) => void;
  connections?: Connection[];
  m: EventTypeMessages;
  locationLabels: BookingMessages['location'];
}) {
  // ADR 0008: the repo names no conferencing platform, the RUNNING product does.
  // The port reports it and it rides here on the connections response the editor
  // already fetches — so a host sees which platform they are choosing. Null (a
  // bare fork, or no calendar connected) falls back to the generic wording,
  // which is correct: there is no conferencing to name. This is a HOST-facing
  // affordance only; invitee surfaces stay generic.
  const conferencingLabel =
    connections?.map((c) => c.conferencingLabel).find((l) => !!l && l.trim() !== '') ?? null;
  const kindLabel: Record<LocationKind, string> = {
    conferencing: conferencingLabel?.trim() || locationLabels.conferencing,
    in_person: locationLabels.inPerson,
    phone: locationLabels.phone,
    custom: locationLabels.custom,
  };
  const detailLabel: Partial<Record<LocationKind, string>> = {
    in_person: m.locationDetailAddress,
    phone: m.locationDetailPhone,
    custom: m.locationDetailCustom,
  };
  // Warn, never disable: a host must be able to configure conferencing BEFORE
  // connecting a calendar, or connecting later leaves a silently broken event.
  // `connections === undefined` is a team event — each host has their own
  // calendar, so there is nothing here to be sure about.
  const missingDestination =
    kind === 'conferencing' && !!connections && !connections.some((c) => c.isDestination);

  return (
    <div className="flex flex-col gap-3">
      <Field label={m.fLocation}>
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as LocationKind | '';
            onKind(next);
            // Detail belongs to the kind that asked for it — carrying an
            // address over into "Phone" would be worse than starting clean.
            if (next !== kind) onDetail('');
          }}
          className={inputCls}
        >
          <option value="">{m.locationNone}</option>
          {LOCATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>
      </Field>

      {kind && kind !== 'conferencing' ? (
        <Field label={detailLabel[kind] ?? m.fLocation}>
          <input
            value={detail}
            onChange={(e) => onDetail(e.target.value)}
            placeholder={m.locationPlaceholder}
            className={inputCls}
          />
        </Field>
      ) : null}

      {kind === 'conferencing' ? (
        <p className="text-xs text-muted-foreground">{m.locationConferencingHint}</p>
      ) : null}

      {missingDestination ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {m.locationNoDestinationWarning}{' '}
          <Link href="/admin/connections" className="font-medium text-primary underline underline-offset-4">
            {m.calendarLinkConnect} →
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export function EventTypeForm({
  initial,
  schedules = [],
  messages: m,
  locationLabels,
  scheduling,
  teamMembers,
  teamId,
  connections,
  redirectOnSuccess,
  backHref,
  backLabel,
  heading,
  headerExtras,
}: {
  initial?: EventType;
  schedules?: Array<{ id: string; name: string }>;
  messages: EventTypeMessages;
  /** Location-kind names (from the shared `location` catalog) — the same copy
   *  the public booking page and the manage page render. */
  locationLabels: BookingMessages['location'];
  /** Scheduling-method names + hints (from the shared `scheduling` catalog). */
  scheduling?: BookingMessages['scheduling'];
  /** The team's members — present only for TEAM event types (edit or create). */
  teamMembers?: TeamMemberOption[];
  /** Create a TEAM event for this team (QA2 fix 5) — the /new surface had no
   *  path to team events at all; editing derives the team from `initial`. */
  teamId?: string;
  /** The host's connected calendars, for the editable "Calendars for this
   *  event" section (PHASE 2) — omitted for TEAM events (each host has their
   *  own connection; a single per-event picker here would be misleading). */
  connections?: Connection[];
  /** When set (the dedicated /new surface), navigate here after a create. */
  redirectOnSuccess?: string;
  /** FormHeader nav + title (the admin screen header system). */
  backHref: string;
  backLabel: string;
  heading: string;
  /** Rendered in the header next to Save — the edit surface mounts the
   *  open-public/copy-link quick actions here (QA4 fix 3). */
  headerExtras?: ReactNode;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const [description, setDescription] = useState(initial?.description ?? '');
  // Where the meeting happens: a KIND plus, for the kinds that need one, a
  // detail. '' is "not specified" — the same absent value the column always had.
  const [locationKind, setLocationKind] = useState<LocationKind | ''>(initial?.location?.kind ?? '');
  const [locationDetail, setLocationDetail] = useState(initial?.location?.detail ?? '');
  const [lengthMinutes, setLength] = useState(initial?.lengthMinutes ?? 30);
  // Hydrate from the stored event — these used to default silently, so EDITING
  // an event reset its notice/interval/buffers on save (QA2 fix 2).
  const [minNotice, setMinNotice] = useState(initial?.minimumBookingNotice ?? 120);
  const [slotInterval, setSlotInterval] = useState<number | ''>(
    initial?.slotInterval ?? initial?.lengthMinutes ?? 30,
  );
  const [beforeBuf, setBeforeBuf] = useState(initial?.beforeEventBuffer ?? 0);
  const [afterBuf, setAfterBuf] = useState(initial?.afterEventBuffer ?? 0);
  const [seats, setSeats] = useState<number | ''>(initial?.seatsPerTimeSlot ?? '');
  const [scheduleId, setScheduleId] = useState<string>(initial?.scheduleId ?? '');
  const [requiresConfirmation, setRequiresConf] = useState(initial?.requiresConfirmation ?? false);
  // Duplicate-booking guard (#69). Hydrated from the event so that EDITING one
  // cannot silently switch it back off — the class of defect QA2 fix 2 already
  // corrected on this form for notice/interval/buffers. A new event starts off,
  // which is also what every event that predates this reads as.
  const [preventDuplicateBookings, setPreventDuplicate] = useState(
    initial?.preventDuplicateBookings ?? false,
  );
  const [hidden, setHidden] = useState(initial?.hidden ?? false);
  // Reminders + follow-up (#68). Editing opens on the effective list the API
  // returns (a never-configured event surfaces the shipped 24h + 1h with the
  // follow-up off). CREATE has no `initial`, so it seeds the same shipped list
  // — the form both shows what the new event will send and submits it, instead
  // of displaying "no reminders" and then storing that empty list as a
  // deliberate "none".
  const [reminders, setReminders] = useState<EventReminder[]>(
    initial?.reminders ?? defaultEventReminders(),
  );
  const [fields, setFields] = useState<IntakeField[]>(
    (initial?.bookingFields as IntakeField[] | undefined)?.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      defaultCountry: f.defaultCountry,
    })) ?? [],
  );
  const isTeamEvent = !!(initial?.teamId ?? teamId) && !!teamMembers && !!scheduling;
  // PHASE 2 — per-event calendar selection (personal events only). Prefill
  // from the event's own configured set when non-empty; otherwise default to
  // the host's CURRENT member-level settings (all check_conflicts calendars +
  // the member's is_destination calendar) — identical to today's behavior.
  const [conflictIds, setConflictIds] = useState<Set<string>>(
    () =>
      new Set(
        initial?.conflictCalendarIds && initial.conflictCalendarIds.length > 0
          ? initial.conflictCalendarIds
          : (connections ?? []).filter((c) => c.checkConflicts).map((c) => c.id),
      ),
  );
  const [destinationId, setDestinationId] = useState<string | null>(
    initial?.destinationCalendarId ?? (connections ?? []).find((c) => c.isDestination)?.id ?? null,
  );
  const toggleConflict = (id: string) =>
    setConflictIds((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [schedulingType, setSchedulingType] = useState<SchedulingMethod>(
    (SCHEDULING_METHODS as readonly string[]).includes(initial?.schedulingType ?? '')
      ? (initial!.schedulingType as SchedulingMethod)
      : 'round_robin',
  );
  const [hosts, setHosts] = useState<HostRow[]>(
    (teamMembers ?? []).map((tm) => {
      const existing = initial?.hosts?.find((h) => h.memberId === tm.memberId);
      return {
        memberId: tm.memberId,
        priority: existing?.priority ?? 0,
        weight: existing?.weight ?? 100,
        isFixed: existing?.isFixed ?? false,
      };
    }),
  );
  const setHost = (memberId: string, patch: Partial<HostRow>) =>
    setHosts((hs) => hs.map((h) => (h.memberId === memberId ? { ...h, ...patch } : h)));
  /** Swap a question with its neighbour — bookingFields is an ordered array and
   *  every render already respects it; this is the only reorder UI (QA3 fix 6b). */
  const moveField = (i: number, dir: -1 | 1) =>
    setFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const [res, setRes] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const { success } = useToast();

  // Country options for phone questions, alphabetical by (EN) name. Filled
  // AFTER mount (QA4-B1): Intl.DisplayNames region names differ between
  // Node's ICU and the browser's (e.g. "Falkland Islands" vs "… (Islas
  // Malvinas)"), so naming them during SSR guarantees a hydration mismatch.
  const [countryOptions, setCountryOptions] = useState<
    Array<{ code: string; dial: string; flag: string; name: string }>
  >([]);
  useEffect(() => {
    setCountryOptions(
      [...COUNTRIES]
        .map((c) => ({ ...c, name: countryName(c.code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugTouched) setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
  };

  const save = () => {
    // Reserved names are a hard stop, not just the inline warning — saving one
    // would make the public page ask the attendee twice (QA3 fix 3).
    if (fields.some((f) => f.name && isReservedFieldName(f.name))) {
      setRes({ ok: false, message: m.reservedBlocked });
      return;
    }
    start(async () => {
      const payload: EventTypePayload = {
        id: initial?.id,
        title,
        slug,
        description: description.trim() || null,
        location: locationKind
          ? {
              kind: locationKind,
              // Conferencing has no host-authored detail — the link is minted
              // by the calendar port at write-out.
              detail: locationKind === 'conferencing' ? null : locationDetail.trim() || null,
            }
          : null,
        lengthMinutes: Number(lengthMinutes),
        minimumBookingNotice: Number(minNotice),
        slotInterval: slotInterval === '' ? null : Number(slotInterval),
        beforeEventBuffer: Number(beforeBuf),
        afterEventBuffer: Number(afterBuf),
        seatsPerTimeSlot: seats === '' ? null : Number(seats),
        scheduleId: scheduleId || null,
        requiresConfirmation,
        // Travels on create AND edit, personal AND team events — both public
        // write paths honour it, so the editor must not offer it on only one.
        preventDuplicateBookings,
        hidden,
        bookingFields: fields.filter((f) => f.name && f.label),
        reminders,
        ...(isTeamEvent
          ? {
              // teamId travels on CREATE only — an existing event never
              // changes teams from this form.
              ...(initial ? {} : { teamId }),
              schedulingType,
              hosts: hosts.map((h) => ({
                memberId: h.memberId,
                priority: h.priority,
                weight: h.weight,
                isFixed: schedulingType === 'fixed_round_robin' ? h.isFixed : false,
              })),
            }
          : connections
            ? {
                // PHASE 2 — personal events only; team events send no calendar
                // config (the API ignores it for team events regardless).
                conflictCalendarIds: [...conflictIds],
                destinationCalendarId: destinationId,
              }
            : {}),
      };
      const r = await saveEventTypeAction(payload);
      setRes(r);
      // Success is a TOAST, not a quiet line below the fold — the old inline
      // "Saved." was easy to miss (QA4 fix 2). Errors stay inline (persistent).
      if (r.ok) success(m.saved);
      // Create on a dedicated /new surface → return to the list on success.
      if (r.ok && !initial && redirectOnSuccess) router.push(redirectOnSuccess);
    });
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormHeader
        backHref={backHref}
        backLabel={backLabel}
        title={heading}
        actions={
          <span className="flex items-center gap-3">
            {headerExtras}
            <Button type="submit" disabled={pending || !title || !slug}>
              {pending ? m.saving : initial ? m.saveChanges : m.createEventType}
            </Button>
          </span>
        }
      />
      <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label={m.fTitle}>
          <input value={title} onChange={(e) => onTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label={m.fSlug}>
          <input value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} className={inputCls} />
        </Field>
      </div>
      <Field label={m.fDescription}>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputCls} />
      </Field>
      <LocationField
        kind={locationKind}
        detail={locationDetail}
        onKind={setLocationKind}
        onDetail={setLocationDetail}
        connections={connections}
        m={m}
        locationLabels={locationLabels}
      />
      <div className="grid grid-cols-3 gap-3">
        <Field label={m.fLength}>
          <input type="number" value={lengthMinutes} onChange={(e) => setLength(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSlotInterval}>
          <input type="number" value={slotInterval} onChange={(e) => setSlotInterval(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fMinNotice}>
          <input type="number" value={minNotice} onChange={(e) => setMinNotice(Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label={m.fBufferBefore}>
          <input type="number" value={beforeBuf} onChange={(e) => setBeforeBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fBufferAfter}>
          <input type="number" value={afterBuf} onChange={(e) => setAfterBuf(Number(e.target.value))} className={inputCls} />
        </Field>
        <Field label={m.fSeats}>
          <input type="number" min={1} placeholder="1" value={seats} onChange={(e) => setSeats(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls} />
        </Field>
      </div>
      <Field label={m.fSchedule}>
        <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)} className={inputCls}>
          <option value="">
            {schedules.length ? m.useDefaultSchedule : m.noSchedules}
          </option>
          {schedules.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      {connections ? (
        <CalendarsForEventSection
          connections={connections}
          conflictIds={conflictIds}
          destinationId={destinationId}
          onToggleConflict={toggleConflict}
          onSetDestination={setDestinationId}
          m={m}
        />
      ) : null}

      {isTeamEvent && scheduling ? (
        <div className="flex flex-col gap-4 rounded-md border border-border bg-background/40 p-4">
          <Field label={m.schedulingMethod}>
            <select
              value={schedulingType}
              onChange={(e) => setSchedulingType(e.target.value as SchedulingMethod)}
              className={inputCls}
            >
              {SCHEDULING_METHODS.map((method) => (
                <option key={method} value={method}>
                  {scheduling[method]}
                </option>
              ))}
            </select>
            <span className="mt-1 text-xs text-muted-foreground">{scheduling[`${schedulingType}_hint`]}</span>
          </Field>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-muted-foreground">{m.hostsTitle}</span>
            {/* Column header — only the fields the active method actually uses. */}
            {schedulingType !== 'collective' ? (
              <div className="flex items-center gap-3 px-1 text-xs text-muted-foreground">
                <span className="flex-1" />
                <span className="w-20 text-center">{m.priority}</span>
                <span className="w-20 text-center">{m.weight}</span>
                {schedulingType === 'fixed_round_robin' ? (
                  <span className="w-16 text-center">{m.fixedHost}</span>
                ) : null}
              </div>
            ) : null}
            {hosts.map((h) => {
              const name = teamMembers!.find((tm) => tm.memberId === h.memberId)?.displayName ?? h.memberId;
              return (
                <div key={h.memberId} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
                  <span className="flex-1 text-sm">{name}</span>
                  {schedulingType !== 'collective' ? (
                    <>
                      <input
                        type="number"
                        aria-label={`${name} — ${m.priority}`}
                        value={h.priority ?? 0}
                        onChange={(e) => setHost(h.memberId, { priority: Number(e.target.value) })}
                        className="w-20 rounded-md border border-input bg-background px-2 py-1 text-center text-sm"
                      />
                      <input
                        type="number"
                        min={1}
                        aria-label={`${name} — ${m.weight}`}
                        value={h.weight ?? 100}
                        onChange={(e) => setHost(h.memberId, { weight: Number(e.target.value) })}
                        className="w-20 rounded-md border border-input bg-background px-2 py-1 text-center text-sm"
                      />
                      {schedulingType === 'fixed_round_robin' ? (
                        <label className="flex w-16 cursor-pointer justify-center" title={m.fixedHostHint}>
                          <Checkbox
                            checked={h.isFixed}
                            onChange={(e) => setHost(h.memberId, { isFixed: e.target.checked })}
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Booking-policy booleans. The duplicate-booking guard (#69) joins the
          row a host already reads for this class of setting, rather than
          opening a section of its own. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={requiresConfirmation} onChange={(e) => setRequiresConf(e.target.checked)} />
            {m.requiresConfirmation}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            {m.hiddenLabel}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={preventDuplicateBookings}
              onChange={(e) => setPreventDuplicate(e.target.checked)}
            />
            {m.duplicateGuard.label}
          </label>
        </div>
        {preventDuplicateBookings ? (
          <p className="text-xs text-muted-foreground">{m.duplicateGuard.hint}</p>
        ) : null}
      </div>

      {/* Intake questions */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">{m.intakeQuestions}</span>
        {/* Built-in fields the public booking page ALWAYS asks — shown locked so
            nobody re-creates "name"/"email" as custom questions and the attendee
            gets asked twice (QA2 fix 7). */}
        <p className="text-xs text-muted-foreground">{m.fixedFieldsHint}</p>
        {[
          { label: m.fixedName, required: true },
          { label: m.fixedEmail, required: true },
          { label: m.fixedNotes, required: false },
        ].map((bf) => (
          <div
            key={bf.label}
            className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background/40 px-3 py-1.5 text-sm text-muted-foreground"
          >
            <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span className="flex-1">
              {bf.label}
              {bf.required ? ' *' : ''}
            </span>
            <span className="text-xs uppercase tracking-wide">{m.alwaysAsked}</span>
          </div>
        ))}
        {fields.map((f, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                placeholder={m.namePlaceholder}
                value={f.name}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') } : x)))}
                className="w-28 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <input
                placeholder={m.labelPlaceholder}
                value={f.label}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <select
                value={f.type}
                onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {f.type === 'phone' ? (
                // Which country the phone selector starts on for attendees
                // (QA4 fix 1b) — stored inside the question definition.
                <select
                  value={f.defaultCountry ?? 'US'}
                  onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, defaultCountry: e.target.value } : x)))}
                  aria-label={`${m.defaultCountryLabel} — ${f.label || f.name}`}
                  title={m.defaultCountryLabel}
                  className="w-36 rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  {countryOptions.length === 0 ? (
                    // SSR/first paint: a bare-code option so the select's value
                    // resolves identically on server and client (QA4-B1); the
                    // named list replaces it right after mount.
                    <option value={f.defaultCountry ?? 'US'}>{f.defaultCountry ?? 'US'}</option>
                  ) : (
                    countryOptions.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.name} {c.dial}
                      </option>
                    ))
                  )}
                </select>
              ) : null}
              <label className="flex cursor-pointer items-center gap-1 text-sm">
                <Checkbox checked={f.required} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                {m.req}
              </label>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveField(i, -1)}
                aria-label={`${m.moveUp} — ${f.label || f.name}`}
                className="text-muted-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
              >
                <ChevronIcon direction="up" />
              </button>
              <button
                type="button"
                disabled={i === fields.length - 1}
                onClick={() => moveField(i, 1)}
                aria-label={`${m.moveDown} — ${f.label || f.name}`}
                className="text-muted-foreground transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted-foreground"
              >
                <ChevronIcon direction="down" />
              </button>
              <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">×</button>
            </div>
            {isReservedFieldName(f.name) ? (
              <p className="text-xs text-destructive" role="alert">
                {m.reservedWarning}
              </p>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFields((fs) => [...fs, { name: '', label: '', type: 'text', required: false }])}
          className="self-start rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary"
        >
          {m.addQuestion}
        </button>
      </div>

      {/* Reminders — below intake, because their {{form.*}} variables read the
          questions defined right above them. */}
      <RemindersSection
        rows={reminders}
        setRows={(fn) => setReminders(fn)}
        fieldNames={fields.filter((f) => f.name && !isReservedFieldName(f.name)).map((f) => f.name)}
        m={m.reminders}
      />

      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      </div>
    </form>
  );
}

const inputCls =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Same inline chevron style as the DateTimePicker's month arrows. */
function ChevronIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      {direction === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}
