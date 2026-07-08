'use client';

import { useActionState } from 'react';
import type { Schedule } from '@/lib/admin-api';
import { saveScheduleAction, type ActionResult } from './actions';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ScheduleEditor({ schedule }: { schedule: Schedule }) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(saveScheduleAction, null);

  // Map existing rules → per-weekday start/end (first recurring rule per day).
  const byDay = new Map<number, { start: string; end: string }>();
  for (const r of schedule.rules) {
    if (!r.days) continue;
    for (const d of r.days) if (!byDay.has(d)) byDay.set(d, { start: r.startTime, end: r.endTime });
  }

  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-border bg-card p-5">
      <input type="hidden" name="scheduleId" value={schedule.id} />
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-medium">{schedule.name}</h3>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Timezone
          <input
            name="timeZone"
            defaultValue={schedule.timeZone}
            className="rounded-md border border-input bg-background px-2 py-1"
          />
        </label>
      </div>
      {DAY_NAMES.map((name, d) => {
        const cur = byDay.get(d);
        return (
          <div key={d} className="flex items-center gap-3">
            <label className="flex w-24 items-center gap-2 text-sm">
              <input type="checkbox" name={`enabled_${d}`} defaultChecked={!!cur} />
              {name}
            </label>
            <input
              name={`start_${d}`}
              type="time"
              defaultValue={cur?.start ?? '09:00'}
              className="rounded-md border border-input bg-background px-2 py-1"
            />
            <span className="text-muted-foreground">–</span>
            <input
              name={`end_${d}`}
              type="time"
              defaultValue={cur?.end ?? '17:00'}
              className="rounded-md border border-input bg-background px-2 py-1"
            />
          </div>
        );
      })}
      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      {res?.ok ? <p className="text-sm text-primary">Saved.</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save availability'}
      </button>
    </form>
  );
}
