'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BookingMessages } from '@slate/shared';
import { createScheduleAction } from './actions';

type AvailabilityMessages = BookingMessages['admin']['availability'];

export function NewSchedule({
  messages: m,
  redirectOnSuccess,
}: {
  messages: AvailabilityMessages;
  /** When set (the dedicated /new surface), navigate here after a create. */
  redirectOnSuccess?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const r = await createScheduleAction(name, tz);
      setMsg(r.ok ? null : (r.message ?? m.saveError));
      if (r.ok) {
        setName('');
        if (redirectOnSuccess) router.push(redirectOnSuccess);
      }
    });

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed border-border p-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.newSchedule}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={m.newSchedulePlaceholder}
          className="w-56 rounded-md border border-input bg-background px-3 py-2"
        />
      </label>
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? m.saving : m.create}
      </button>
      {msg ? <span className="text-sm text-destructive">{msg}</span> : null}
    </div>
  );
}
