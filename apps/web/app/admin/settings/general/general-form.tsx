'use client';

import { useActionState, useState } from 'react';
import type { BookingMessages } from '@slate/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TimeZoneSelect } from '@/components/ui/timezone-select';
import { saveGeneralAction, type ActionResult } from './actions';

export function GeneralForm({
  displayName,
  handle,
  accountCode,
  timeZone,
  messages: m,
  locale,
}: {
  displayName: string;
  handle: string;
  accountCode: string;
  timeZone: string;
  messages: BookingMessages['admin']['settingsGeneral'];
  locale?: string;
}) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(saveGeneralAction, null);
  // Controlled: the themed combobox isn't a form control, so the picked zone
  // travels through a hidden input.
  const [tz, setTz] = useState(timeZone);

  return (
    <form action={action} className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:p-6">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.displayName}</span>
        <Input name="displayName" defaultValue={displayName} className="min-h-[44px]" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.publicHandle}</span>
        {/* The `/account/` prefix is part of the URL, so it reads in the mono
            voice next to the field that completes it, and wraps above the input
            at 360px rather than squeezing it. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">/{accountCode}/</span>
          <Input name="handle" defaultValue={handle} className="min-h-[44px] flex-1" />
        </div>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.timezone}</span>
        {/* Full IANA list, never free text: an invalid zone used to reach the
            DB and crash every page that formats times (QA fix 1). Themed
            combobox instead of the native OS popup (QA2 fix 1). */}
        <TimeZoneSelect value={tz} onChange={setTz} locale={locale} ariaLabel={m.timezone} />
        <input type="hidden" name="timeZone" value={tz} />
      </div>
      {res && !res.ok ? <p role="alert" className="text-sm text-destructive">{res.message}</p> : null}
      {res?.ok ? <p className="text-sm text-primary">{m.saved}</p> : null}
      <Button type="submit" size="lg" disabled={pending} className="self-start px-5">
        {pending ? m.saving : m.save}
      </Button>
    </form>
  );
}
