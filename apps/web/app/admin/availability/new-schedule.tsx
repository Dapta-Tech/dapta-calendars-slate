'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { FormHeader } from '@/components/ui/page-header';
import { createScheduleAction } from './actions';

type AvailabilityMessages = BookingMessages['admin']['availability'];

export function NewSchedule({
  messages: m,
  backHref,
  backLabel,
}: {
  messages: AvailabilityMessages;
  backHref: string;
  backLabel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const r = await createScheduleAction(name, tz);
      if (r.ok) {
        // Land on the new schedule's editor so the user sets hours right away.
        router.push(r.id ? `/admin/availability/${r.id}` : backHref);
      } else {
        setMsg(r.message ?? m.saveError);
      }
    });

  return (
    <form onSubmit={(e) => { e.preventDefault(); create(); }}>
      <FormHeader
        backHref={backHref}
        backLabel={backLabel}
        title={m.newSchedule}
        actions={
          <Button type="submit" disabled={pending}>
            {pending ? m.saving : m.create}
          </Button>
        }
      />
      <div className="flex flex-col gap-4 rounded-md border border-border bg-card p-6">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.scheduleNameLabel}</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={m.newSchedulePlaceholder}
            className="w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {msg ? <span className="text-sm text-destructive">{msg}</span> : null}
      </div>
    </form>
  );
}
