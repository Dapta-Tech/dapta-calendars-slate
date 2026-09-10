'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { t, validateDayRanges, type BookingMessages, type Locale, type TimeRange } from '@slate/shared';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { FormHeader } from '@/components/ui/page-header';
import { TimeField } from '@/components/ui/time-field';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import type { Schedule } from '@/lib/admin-api';
import { deleteScheduleAction, saveScheduleFullAction, type RuleInput } from './actions';

type AvailabilityMessages = BookingMessages['admin']['availability'];

interface Override {
  date: string;
  start: string;
  end: string;
}

/** Seed each weekday with ALL of its ranges (was: last-rule-wins → data loss). */
function seedWeek(schedule: Schedule): TimeRange[][] {
  const week: TimeRange[][] = Array.from({ length: 7 }, () => []);
  for (const r of schedule.rules) {
    if (!r.days) continue;
    for (const d of r.days) week[d]!.push({ start: r.startTime, end: r.endTime });
  }
  return week;
}

export function ScheduleEditor({
  schedule,
  messages: m,
  backHref,
  backLabel,
  locale,
}: {
  schedule: Schedule;
  messages: AvailabilityMessages;
  backHref: string;
  backLabel: string;
  /** Active admin locale — the picker's and ConfirmDialog's own copy. */
  locale?: Locale;
}) {
  const router = useRouter();
  const [name, setName] = useState(schedule.name);
  const [timeZone, setTimeZone] = useState(schedule.timeZone);
  const [week, setWeek] = useState<TimeRange[][]>(() => seedWeek(schedule));
  const [overrides, setOverrides] = useState<Override[]>(() =>
    schedule.rules.filter((r) => r.date).map((r) => ({ date: r.date!, start: r.startTime, end: r.endTime })),
  );
  const [pending, start] = useTransition();
  const { success, error } = useToast();
  const { confirm, dialog } = useConfirmDialog(locale);

  const setRanges = (d: number, ranges: TimeRange[]) =>
    setWeek((w) => w.map((r, i) => (i === d ? ranges : r)));
  const toggleDay = (d: number, on: boolean) =>
    setRanges(d, on ? [{ start: '09:00', end: '17:00' }] : []);
  const addRange = (d: number) => setRanges(d, [...week[d]!, { start: '09:00', end: '17:00' }]);

  // Per-day overlap/inverted validation (blocks Save with a clear message).
  const dayError = (d: number) => (week[d]!.length ? validateDayRanges(week[d]!) : null);
  const firstError = week.map((_, d) => dayError(d)).find(Boolean) ?? null;

  const save = () =>
    start(async () => {
      if (firstError) {
        error(firstError);
        return;
      }
      const rules: RuleInput[] = [];
      week.forEach((ranges, d) => {
        for (const r of ranges) rules.push({ days: [d], startTime: r.start, endTime: r.end, date: null });
      });
      for (const o of overrides) {
        if (o.date) rules.push({ days: null, startTime: o.start, endTime: o.end, date: o.date });
      }
      const res = await saveScheduleFullAction(schedule.id, name, timeZone, rules);
      if (res.ok) success(m.savedToast);
      else error(res.message ?? m.saveError);
    });

  // A2 (#112): the sticky header used to grow a Yes/No pair where the Delete
  // button had just been, which is the worst place to put an irreversible
  // second click. It asks through the dialog now, and names the schedule.
  const askRemove = async () => {
    const ok = await confirm({
      title: m.deleteTitle,
      message: t(m.deleteBody, { name: name.trim() || schedule.name }),
      confirmLabel: m.deleteSchedule,
      destructive: true,
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteScheduleAction(schedule.id);
      if (!r.ok) error(r.message ?? m.deleteError);
      else {
        success(m.deletedToast);
        router.push(backHref);
      }
    });
  };

  const actions = (
    <>
      <Button variant="destructive" size="lg" disabled={pending} onClick={() => void askRemove()}>
        {m.deleteSchedule}
      </Button>
      <Button type="submit" size="lg" disabled={pending || !!firstError}>
        {pending ? m.saving : m.save}
      </Button>
    </>
  );

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormHeader
        backHref={backHref}
        backLabel={backLabel}
        actions={actions}
        gutter="responsive"
        title={
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={m.scheduleNameLabel}
            className="min-h-[44px] w-full min-w-0 rounded-md border border-transparent bg-transparent px-1 text-2xl font-semibold tracking-tight hover:border-border focus:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      />

      <div className="flex flex-col gap-4">
      {/* The full IANA list with its GMT hints, not the short curated one this
          used to offer: the profile and the manual-booking form already give the
          whole list, and a schedule that cannot be set to a zone the profile can
          be set to is the inconsistency. A <div>, not a <label>, because the
          picker's trigger is a <button> and buttons are not labelable. */}
      <div className="flex max-w-sm flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.timezone}</span>
        <TimeZoneSelect value={timeZone} onChange={setTimeZone} locale={locale} ariaLabel={m.timezone} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">{m.weeklyHours}</span>
        {m.days.map((dayName, d) => {
          const ranges = week[d]!;
          const on = ranges.length > 0;
          const err = dayError(d);
          return (
            // A 128px day label plus two 128px time fields plus a remove button is
            // ~300px of FIXED width, inside 328px of content at 360px — before the
            // gaps. Below `sm` the day owns its own line and the ranges sit under
            // it; from `sm` up the row is exactly what it was.
            <div key={d} className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-b-0">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:gap-3">
                <label className="flex min-h-[44px] shrink-0 cursor-pointer items-center gap-2 text-sm sm:w-32">
                  <Checkbox checked={on} onChange={(e) => toggleDay(d, e.target.checked)} />
                  {dayName}
                </label>
                {on ? (
                  <div className="flex flex-1 flex-col gap-2">
                    {ranges.map((r, ri) => (
                      <div key={ri} className="flex items-center gap-2">
                        <TimeField
                          className="min-w-0 flex-1 sm:w-32 sm:flex-none"
                          aria-label={`${dayName} start`}
                          value={r.start}
                          onChange={(v) => setRanges(d, ranges.map((x, j) => (j === ri ? { ...x, start: v } : x)))}
                        />
                        <span className="text-muted-foreground">–</span>
                        <TimeField
                          className="min-w-0 flex-1 sm:w-32 sm:flex-none"
                          aria-label={`${dayName} end`}
                          value={r.end}
                          onChange={(v) => setRanges(d, ranges.map((x, j) => (j === ri ? { ...x, end: v } : x)))}
                        />
                        {/* Was a bare `×` in a 32px box. A real icon, on the 44px step. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${m.removeRange} · ${dayName}`}
                          onClick={() => setRanges(d, ranges.filter((_, j) => j !== ri))}
                          className="h-11 w-11 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <i aria-hidden className="pi pi-times" style={{ fontSize: 13 }} />
                        </Button>
                      </div>
                    ))}
                    <Button variant="ghost" size="lg" onClick={() => addRange(d)} className="-ml-3 self-start">
                      <i aria-hidden className="pi pi-plus" style={{ fontSize: 12 }} />
                      {m.addRange}
                    </Button>
                  </div>
                ) : (
                  <span className="py-1.5 text-sm text-muted-foreground">{m.unavailable}</span>
                )}
              </div>
              {err ? <span className="text-xs text-destructive sm:pl-32">{err}</span> : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">{m.dateOverrides}</span>
        {overrides.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Input
              type="date"
              value={o.date}
              aria-label={m.dateOverrides}
              className="min-h-[44px] w-auto shrink-0"
              onChange={(e) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
            />
            <TimeField
              className="min-w-0 flex-1 sm:w-32 sm:flex-none"
              value={o.start}
              onChange={(v) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, start: v } : x)))}
            />
            <span className="text-muted-foreground">–</span>
            <TimeField
              className="min-w-0 flex-1 sm:w-32 sm:flex-none"
              value={o.end}
              onChange={(v) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, end: v } : x)))}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.removeOverride}
              onClick={() => setOverrides((os) => os.filter((_, j) => j !== i))}
              className="h-11 w-11 shrink-0 text-muted-foreground hover:text-destructive"
            >
              <i aria-hidden className="pi pi-times" style={{ fontSize: 13 }} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="lg"
          onClick={() => setOverrides((os) => [...os, { date: '', start: '09:00', end: '17:00' }])}
          className="self-start text-muted-foreground"
        >
          <i aria-hidden className="pi pi-plus" style={{ fontSize: 12 }} />
          {m.addOverride}
        </Button>
        <p className="text-xs text-muted-foreground">{m.overrideNote}</p>
      </div>
      </div>
      {dialog}
    </form>
  );
}
