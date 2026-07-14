'use client';

import { useActionState, useState } from 'react';
import type { BookingMessages } from '@slate/shared';
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
  const cls = 'rounded-md border border-input bg-background px-3 py-2';

  return (
    <form action={action} className="flex flex-col gap-4 rounded-md border border-border bg-card p-6">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.displayName}</span>
        <input name="displayName" defaultValue={displayName} className={cls} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{m.publicHandle}</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">/{accountCode}/</span>
          <input name="handle" defaultValue={handle} className={`${cls} flex-1`} />
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
      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      {res?.ok ? <p className="text-sm text-primary">{m.saved}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? m.saving : m.save}
      </button>
    </form>
  );
}
