'use client';

import Link from 'next/link';
import type { CustomHoursRange } from '@slate/types';
import { Radio } from '@/components/ui/radio';
import { TimeField } from '@/components/ui/time-field';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { inputCls, type EventTypeMessages } from './shared';

export type AvailabilitySource = 'working' | 'saved' | 'custom';

/** An event's own hours as the editor holds them. */
export interface CustomHoursDraft {
  timeZone: string;
  ranges: CustomHoursRange[];
}

/** What a stored schedule's rule looks like (`days` null = a date override). */
export interface ScheduleRule {
  days: number[] | null;
  startTime: string;
  endTime: string;
  date: string | null;
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];
/** Monday first, the order hosts read a week in. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const sameDays = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);

/** The day selector's value for a row's days: a preset, one weekday, or a custom set. */
export function dayKeyOf(days: readonly number[]): string {
  if (sameDays(days, EVERY_DAY)) return 'every';
  if (sameDays(days, WEEKDAYS)) return 'weekdays';
  if (sameDays(days, WEEKENDS)) return 'weekends';
  if (days.length === 1) return String(days[0]);
  return `set:${[...days].sort().join(',')}`;
}

export function daysOfKey(key: string): number[] {
  if (key === 'every') return [...EVERY_DAY];
  if (key === 'weekdays') return [...WEEKDAYS];
  if (key === 'weekends') return [...WEEKENDS];
  if (key.startsWith('set:')) return key.slice(4).split(',').map(Number);
  return [Number(key)];
}

/**
 * Working hours as editable rows: ranges with the same times are joined, and a
 * set of days that matches a preset (Weekdays, Weekends, Every day) becomes one
 * row; any other set is one row per day. Date overrides do not carry over.
 */
export function rowsFromRules(rules: readonly ScheduleRule[]): CustomHoursRange[] {
  const byTime = new Map<string, Set<number>>();
  for (const r of rules) {
    if (!r.days || r.date) continue;
    const key = `${r.startTime}-${r.endTime}`;
    const set = byTime.get(key) ?? new Set<number>();
    for (const d of r.days) set.add(d);
    byTime.set(key, set);
  }
  const rows: CustomHoursRange[] = [];
  for (const [key, set] of byTime) {
    const [start, end] = key.split('-') as [string, string];
    const days = [...set].sort();
    if ([EVERY_DAY, WEEKDAYS, WEEKENDS].some((p) => sameDays(days, p))) rows.push({ days, start, end });
    else for (const d of days) rows.push({ days: [d], start, end });
  }
  const firstDay = (r: CustomHoursRange) => Math.min(...r.days.map((d) => WEEK_ORDER.indexOf(d)));
  return rows.sort((a, b) => firstDay(a) - firstDay(b) || a.start.localeCompare(b.start));
}

/** "+ Add hours": the next weekday no row covers yet, at the previous row's times. */
export function nextRow(rows: readonly CustomHoursRange[]): CustomHoursRange {
  const covered = new Set(rows.flatMap((r) => r.days));
  const day = WEEK_ORDER.find((d) => !covered.has(d)) ?? 1;
  const last = rows[rows.length - 1];
  return { days: [day], start: last?.start ?? '09:00', end: last?.end ?? '17:00' };
}

/** Field ids for the hours editor's controls (the guidance focuses them). */
export const HOURS_IDS = {
  list: 'et-hours',
  day: (i: number) => `et-hours-${i}-day`,
  start: (i: number) => `et-hours-${i}-start`,
  end: (i: number) => `et-hours-${i}-end`,
} as const;

/** Monday-first summary of rules, for the read-only working hours. */
function summaryOf(rows: readonly CustomHoursRange[], m: EventTypeMessages['editor']['availability']): string[] {
  return rows.map((r) => `${dayLabel(dayKeyOf(r.days), m)} · ${r.start}–${r.end}`);
}

function dayLabel(key: string, m: EventTypeMessages['editor']['availability']): string {
  if (key === 'every') return m.everyDay;
  if (key === 'weekdays') return m.weekdays;
  if (key === 'weekends') return m.weekends;
  return daysOfKey(key)
    .map((d) => m.days[d])
    .join(', ');
}

/**
 * Where an event's bookable hours come from: the host's working hours (the
 * default), one of their saved schedules, or hours of its own, edited inline
 * as rows of day → from → to. Team events keep their hosts' own hours.
 */
export function AvailabilityField({
  source,
  onSource,
  scheduleId,
  onScheduleId,
  schedules,
  workingHours,
  customHours,
  onCustomHours,
  isTeam,
  errorFor,
  locale,
  m,
  savedLabel,
}: {
  source: AvailabilitySource;
  onSource: (s: AvailabilitySource) => void;
  scheduleId: string;
  onScheduleId: (id: string) => void;
  schedules: ReadonlyArray<{ id: string; name: string; isDefault?: boolean }>;
  workingHours?: { timeZone: string; rules: ScheduleRule[] } | null;
  customHours: CustomHoursDraft;
  onCustomHours: (next: CustomHoursDraft) => void;
  isTeam: boolean;
  errorFor: (fieldId: string) => string | null;
  locale: 'en' | 'es';
  m: EventTypeMessages['editor']['availability'];
  /** The saved-schedule picker's label. */
  savedLabel: string;
}) {
  const reusable = schedules;
  const working = workingHours ? rowsFromRules(workingHours.rules) : [];
  const setRow = (i: number, patch: Partial<CustomHoursRange>) =>
    onCustomHours({ ...customHours, ranges: customHours.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const listError = errorFor(HOURS_IDS.list);

  const option = (value: AvailabilitySource, label: string, disabled = false) => (
    <label className={`flex items-center gap-inline text-sm ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <Radio
        name="et-availability-source"
        value={value}
        checked={source === value}
        disabled={disabled}
        onChange={() => onSource(value)}
      />
      {label}
    </label>
  );

  return (
    <fieldset className="flex flex-col gap-field">
      <legend className="mb-tight text-sm text-muted-foreground">{m.label}</legend>
      <div className="flex flex-col gap-inline sm:flex-row sm:flex-wrap sm:gap-x-group">
        {option('working', m.workingHours)}
        {option('saved', m.saved, reusable.length === 0)}
        {isTeam ? null : option('custom', m.custom)}
      </div>
      {isTeam ? <p className="text-xs text-muted-foreground">{m.team}</p> : null}

      {source === 'working' ? (
        <div className="flex flex-col gap-tight rounded-md border border-border bg-background/40 px-field py-inline text-sm">
          <p className="text-xs text-muted-foreground">{m.workingHoursHint}</p>
          {working.length ? (
            <ul data-testid="et-working-hours" className="flex flex-col gap-tight text-foreground">
              {summaryOf(working, m).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{m.noWorkingHours}</p>
          )}
          <Link href="/admin/availability" className="self-start text-sm font-medium text-primary underline underline-offset-4">
            {m.editWorkingHours}
          </Link>
        </div>
      ) : null}

      {source === 'saved' ? (
        <label className="flex flex-col gap-tight text-sm">
          <span className="text-muted-foreground">{savedLabel}</span>
          <select value={scheduleId} onChange={(e) => onScheduleId(e.target.value)} className={inputCls}>
            {reusable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {source === 'custom' ? (
        <div className="flex flex-col gap-field rounded-md border border-border bg-background/40 p-card">
          <p className="text-xs text-muted-foreground">{m.customHint}</p>
          <ul id={HOURS_IDS.list} tabIndex={-1} className="flex flex-col gap-inline focus-visible:outline-none">
            {customHours.ranges.map((r, i) => {
              const key = dayKeyOf(r.days);
              const rowError = errorFor(HOURS_IDS.day(i)) ?? errorFor(HOURS_IDS.end(i));
              const dayName = dayLabel(key, m);
              return (
                <li key={i} className="flex flex-col gap-tight">
                  <div className="flex flex-wrap items-center gap-inline">
                    <select
                      id={HOURS_IDS.day(i)}
                      aria-label={m.dayLabel}
                      value={key}
                      onChange={(e) => setRow(i, { days: daysOfKey(e.target.value) })}
                      aria-invalid={errorFor(HOURS_IDS.day(i)) ? true : undefined}
                      className="min-w-[9rem] rounded-md border border-input bg-background px-inline py-tight text-sm"
                    >
                      <option value="every">{m.everyDay}</option>
                      <option value="weekdays">{m.weekdays}</option>
                      <option value="weekends">{m.weekends}</option>
                      {WEEK_ORDER.map((d) => (
                        <option key={d} value={String(d)}>
                          {m.days[d]}
                        </option>
                      ))}
                      {key.startsWith('set:') ? <option value={key}>{dayName}</option> : null}
                    </select>
                    <span className="text-sm text-muted-foreground">{m.from}</span>
                    <TimeField
                      id={HOURS_IDS.start(i)}
                      aria-label={`${dayName} — ${m.from}`}
                      value={r.start}
                      onChange={(start) => setRow(i, { start })}
                    />
                    <span className="text-sm text-muted-foreground">{m.to}</span>
                    <TimeField
                      id={HOURS_IDS.end(i)}
                      aria-label={`${dayName} — ${m.to}`}
                      value={r.end}
                      invalid={!!errorFor(HOURS_IDS.end(i))}
                      onChange={(end) => setRow(i, { end })}
                    />
                    <button
                      type="button"
                      aria-label={`${m.remove} — ${dayName}`}
                      onClick={() =>
                        onCustomHours({ ...customHours, ranges: customHours.ranges.filter((_, j) => j !== i) })
                      }
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <i aria-hidden className="pi pi-trash" style={{ fontSize: 14 }} />
                    </button>
                  </div>
                  {rowError ? <p className="text-xs text-destructive">{rowError}</p> : null}
                </li>
              );
            })}
          </ul>
          {listError ? <p className="text-xs text-destructive">{listError}</p> : null}
          <button
            type="button"
            onClick={() => onCustomHours({ ...customHours, ranges: [...customHours.ranges, nextRow(customHours.ranges)] })}
            className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            + {m.addHours}
          </button>
          <label className="flex flex-col gap-tight text-sm sm:max-w-sm">
            <span className="text-muted-foreground">{m.timeZone}</span>
            <TimeZoneSelect
              value={customHours.timeZone}
              onChange={(timeZone) => onCustomHours({ ...customHours, timeZone })}
              locale={locale}
              ariaLabel={m.timeZone}
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}
