'use client';

import { useActionState } from 'react';
import type { EventType } from '@/lib/admin-api';
import { createEventTypeAction, updateEventTypeAction, type ActionResult } from './actions';

export function EventTypeForm({ initial }: { initial?: EventType }) {
  const action = initial ? updateEventTypeAction : createEventTypeAction;
  const [res, formAction, pending] = useActionState<ActionResult | null, FormData>(action, null);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-5"
    >
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title">
          <input name="title" required defaultValue={initial?.title} className={inputCls} />
        </Field>
        <Field label="Slug">
          <input name="slug" required defaultValue={initial?.slug} className={inputCls} />
        </Field>
      </div>
      <Field label="Description">
        <textarea name="description" rows={2} defaultValue={initial?.description ?? ''} className={inputCls} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Length (min)">
          <input name="lengthMinutes" type="number" defaultValue={initial?.lengthMinutes ?? 30} className={inputCls} />
        </Field>
        <Field label="Min. notice (min)">
          <input name="minimumBookingNotice" type="number" defaultValue={120} className={inputCls} />
        </Field>
        <Field label="Slot interval (min)">
          <input name="slotInterval" type="number" defaultValue={initial?.lengthMinutes ?? 30} className={inputCls} />
        </Field>
      </div>
      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresConfirmation" defaultChecked={initial?.requiresConfirmation} />
          Requires confirmation
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="hidden" defaultChecked={initial?.hidden} />
          Hidden
        </label>
      </div>
      {res && !res.ok ? <p className="text-sm text-destructive">{res.message}</p> : null}
      {res?.ok ? <p className="text-sm text-primary">Saved.</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {pending ? 'Saving…' : initial ? 'Save changes' : 'Create event type'}
      </button>
    </form>
  );
}

const inputCls = 'rounded-md border border-input bg-background px-3 py-2 w-full';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
