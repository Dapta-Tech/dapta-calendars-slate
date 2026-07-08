'use client';

import { useState, useTransition } from 'react';
import type { Schedule } from '@/lib/admin-api';
import { saveScheduleFullAction, type RuleInput } from './actions';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface WeekdayRow {
  enabled: boolean;
  start: string;
  end: string;
}
interface Override {
  date: string;
  start: string;
  end: string;
}

export function ScheduleEditor({ schedule }: { schedule: Schedule }) {
  const [timeZone, setTimeZone] = useState(schedule.timeZone);
  const [week, setWeek] = useState<WeekdayRow[]>(() => {
    const rows: WeekdayRow[] = DAY_NAMES.map(() => ({ enabled: false, start: '09:00', end: '17:00' }));
    for (const r of schedule.rules) {
      if (!r.days) continue;
      for (const d of r.days) rows[d] = { enabled: true, start: r.startTime, end: r.endTime };
    }
    return rows;
  });
  const [overrides, setOverrides] = useState<Override[]>(() =>
    schedule.rules
      .filter((r) => r.date)
      .map((r) => ({ date: r.date!, start: r.startTime, end: r.endTime })),
  );
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const setDay = (d: number, patch: Partial<WeekdayRow>) =>
    setWeek((w) => w.map((row, i) => (i === d ? { ...row, ...patch } : row)));

  const save = () =>
    start(async () => {
      const rules: RuleInput[] = [];
      week.forEach((row, d) => {
        if (row.enabled) rules.push({ days: [d], startTime: row.start, endTime: row.end, date: null });
      });
      for (const o of overrides) {
        if (o.date) rules.push({ days: null, startTime: o.start, endTime: o.end, date: o.date });
      }
      const r = await saveScheduleFullAction(schedule.id, timeZone, rules);
      setMsg({ ok: r.ok, text: r.ok ? 'Saved.' : (r.message ?? 'Failed') });
    });

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{schedule.name}</h3>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Timezone
          <input
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-muted-foreground">Weekly hours</span>
        {DAY_NAMES.map((name, d) => (
          <div key={d} className="flex items-center gap-3">
            <label className="flex w-24 items-center gap-2 text-sm">
              <input type="checkbox" checked={week[d]!.enabled} onChange={(e) => setDay(d, { enabled: e.target.checked })} />
              {name}
            </label>
            <input
              type="time"
              value={week[d]!.start}
              disabled={!week[d]!.enabled}
              onChange={(e) => setDay(d, { start: e.target.value })}
              className="rounded-md border border-input bg-background px-2 py-1 disabled:opacity-40"
            />
            <span className="text-muted-foreground">–</span>
            <input
              type="time"
              value={week[d]!.end}
              disabled={!week[d]!.enabled}
              onChange={(e) => setDay(d, { end: e.target.value })}
              className="rounded-md border border-input bg-background px-2 py-1 disabled:opacity-40"
            />
          </div>
        ))}
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
        <p className="text-xs text-muted-foreground">
          An override replaces the weekly hours for that specific date.
        </p>
      </div>

      {msg ? <p className={`text-sm ${msg.ok ? 'text-primary' : 'text-destructive'}`}>{msg.text}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save availability'}
      </button>
    </div>
  );
}
