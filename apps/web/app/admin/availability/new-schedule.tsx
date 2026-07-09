'use client';

import { useState, useTransition } from 'react';
import { createScheduleAction } from './actions';

export function NewSchedule() {
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const r = await createScheduleAction(name, tz);
      setMsg(r.ok ? null : (r.message ?? 'Failed'));
      if (r.ok) setName('');
    });

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed border-border p-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">New schedule name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Working hours"
          className="w-56 rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? 'Creating…' : 'Create schedule'}
      </button>
      {msg ? <span className="text-sm text-destructive">{msg}</span> : null}
    </div>
  );
}
