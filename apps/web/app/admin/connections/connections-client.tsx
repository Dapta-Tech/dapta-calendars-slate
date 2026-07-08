'use client';

import { useActionState, useTransition } from 'react';
import type { Connection } from '@/lib/admin-api';
import { createConnectionAction, deleteConnectionAction, type ActionResult } from './actions';

export function ConnectionsClient({ connections }: { connections: Connection[] }) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(createConnectionAction, null);
  const [delPending, start] = useTransition();

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-2">
        {connections.map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded-md border border-border bg-card p-4">
            <span className="flex flex-col">
              <span className="font-medium capitalize">{c.provider}</span>
              <span className="text-sm text-muted-foreground">
                {c.primaryEmail ?? c.externalId}
                {c.isDestination ? ' · destination' : ''}
                {c.checkConflicts ? ' · conflict check' : ''}
              </span>
            </span>
            <button
              type="button"
              disabled={delPending}
              onClick={() => start(() => deleteConnectionAction(c.id))}
              className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
            >
              Disconnect
            </button>
          </li>
        ))}
        {connections.length === 0 ? (
          <li className="text-sm text-muted-foreground">No connected calendars.</li>
        ) : null}
      </ul>

      <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Provider</span>
          <select name="provider" className="rounded-md border border-input bg-background px-3 py-2">
            <option value="google">google</option>
            <option value="outlook">outlook</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Calendar id / email</span>
          <input name="externalId" required className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="checkConflicts" defaultChecked /> conflict check
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isDestination" /> destination
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? '…' : 'Add connection'}
        </button>
        {res && !res.ok ? <p className="w-full text-sm text-destructive">{res.message}</p> : null}
      </form>
    </div>
  );
}
