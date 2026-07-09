'use client';

import { useMemo, useState, useTransition } from 'react';
import { commonTimeZones, validateDayRanges, type TimeRange } from '@slate/shared';
import type { Schedule } from '@/lib/admin-api';
import { deleteScheduleAction, saveScheduleFullAction, type RuleInput } from './actions';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Override {
  date: string;
  start: string;
  end: string;
}

/** Seed each weekday with ALL of its ranges (was: last-rule-wins → data loss). */
function seedWeek(schedule: Schedule): TimeRange[][] {
  const week: TimeRange[][] = DAY_NAMES.map(() => []);
  for (const r of schedule.rules) {
    if (!r.days) continue;
    for (const d of r.days) week[d]!.push({ start: r.startTime, end: r.endTime });
  }
  return week;
}

export function ScheduleEditor({ schedule }: { schedule: Schedule }) {
  const [name, setName] = useState(schedule.name);
  const [timeZone, setTimeZone] = useState(schedule.timeZone);
  const [week, setWeek] = useState<TimeRange[][]>(() => seedWeek(schedule));
  const [overrides, setOverrides] = useState<Override[]>(() =>
    schedule.rules.filter((r) => r.date).map((r) => ({ date: r.date!, start: r.startTime, end: r.endTime })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [pending, start] = useTransition();
  const zones = useMemo(() => commonTimeZones(timeZone), [timeZone]);

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
        setMsg({ ok: false, text: firstError });
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
      setMsg({ ok: res.ok, text: res.ok ? 'Saved.' : (res.message ?? 'Failed') });
    });

  const remove = () => start(async () => void (await deleteScheduleAction(schedule.id)));

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Schedule name"
          className="rounded-md border border-transparent bg-transparent px-1 text-lg font-medium hover:border-border focus:border-input"
        />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Timezone
            <select
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          {confirmDel ? (
            <span className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">Delete?</span>
              <button type="button" onClick={remove} disabled={pending} className="rounded-md border border-destructive px-2 py-1 text-destructive">
                Yes
              </button>
              <button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-border px-2 py-1">
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDel(true)}
              className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">Weekly hours</span>
        {DAY_NAMES.map((dayName, d) => {
          const ranges = week[d]!;
          const on = ranges.length > 0;
          const err = dayError(d);
          return (
            <div key={d} className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-b-0">
              <div className="flex flex-wrap items-start gap-3">
                <label className="flex w-32 shrink-0 items-center gap-2 py-1.5 text-sm">
                  <input type="checkbox" checked={on} onChange={(e) => toggleDay(d, e.target.checked)} />
                  {dayName}
                </label>
                {on ? (
                  <div className="flex flex-1 flex-col gap-2">
                    {ranges.map((r, ri) => (
                      <div key={ri} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={r.start}
                          onChange={(e) => setRanges(d, ranges.map((x, j) => (j === ri ? { ...x, start: e.target.value } : x)))}
                          className="rounded-md border border-input bg-background px-2 py-1"
                        />
                        <span className="text-muted-foreground">–</span>
                        <input
                          type="time"
                          value={r.end}
                          onChange={(e) => setRanges(d, ranges.map((x, j) => (j === ri ? { ...x, end: e.target.value } : x)))}
                          className="rounded-md border border-input bg-background px-2 py-1"
                        />
                        <button
                          type="button"
                          aria-label="Remove range"
                          onClick={() => setRanges(d, ranges.filter((_, j) => j !== ri))}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-destructive"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addRange(d)}
                      className="self-start text-xs text-primary hover:underline"
                    >
                      + Add a range
                    </button>
                  </div>
                ) : (
                  <span className="py-1.5 text-sm text-muted-foreground">Unavailable</span>
                )}
              </div>
              {err ? <span className="pl-32 text-xs text-destructive">{err}</span> : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">Date overrides</span>
        {overrides.map((o, i) => (
          <div key={i} className="flex items-center gap-3">
            <input
              type="date"
              value={o.date}
              onChange={(e) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
              className="rounded-md border border-input bg-background px-2 py-1"
            />
            <input
              type="time"
              value={o.start}
              onChange={(e) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
              className="rounded-md border border-input bg-background px-2 py-1"
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="time"
              value={o.end}
              onChange={(e) => setOverrides((os) => os.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
              className="rounded-md border border-input bg-background px-2 py-1"
            />
            <button
              type="button"
              onClick={() => setOverrides((os) => os.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setOverrides((os) => [...os, { date: '', start: '09:00', end: '17:00' }])}
          className="self-start rounded-md border border-border px-3 py-1 text-sm text-muted-foreground hover:border-primary"
        >
          + Add date override
        </button>
        <p className="text-xs text-muted-foreground">An override replaces the weekly hours for that specific date.</p>
      </div>

      {msg ? <p className={`text-sm ${msg.ok ? 'text-primary' : 'text-destructive'}`}>{msg.text}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={pending || !!firstError}
        className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save availability'}
      </button>
    </div>
  );
}
