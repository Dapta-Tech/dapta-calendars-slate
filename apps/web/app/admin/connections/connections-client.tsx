'use client';

import { useActionState, useState, useTransition } from 'react';
import type { Connection } from '@/lib/admin-api';
import {
  connectCalendarAction,
  createConnectionAction,
  deleteConnectionAction,
  pingConnectionAction,
  toggleConnectionAction,
  type ActionResult,
} from './actions';

function ConnectCta() {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border p-4">
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setMsg((await connectCalendarAction()).message))}
        className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        Connect a calendar
      </button>
      <span className="text-sm text-muted-foreground">
        {msg ?? 'Google / Outlook via OAuth (needs a configured provider in your deployment).'}
      </span>
    </div>
  );
}

function ConnectionRow({ c }: { c: Connection }) {
  const [pending, start] = useTransition();
  const [ping, setPing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="flex items-center justify-between rounded-md border border-border bg-card p-4">
      <span className="flex flex-col gap-1">
        <span className="font-medium capitalize">{c.provider}</span>
        <span className="text-sm text-muted-foreground">{c.primaryEmail ?? c.externalId}</span>
        <span className="mt-1 flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={c.isDestination}
              disabled={pending}
              onChange={(e) => start(() => toggleConnectionAction(c.id, { isDestination: e.target.checked }))}
            />
            Destination
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={c.checkConflicts}
              disabled={pending}
              onChange={(e) => start(() => toggleConnectionAction(c.id, { checkConflicts: e.target.checked }))}
            />
            Conflict check
          </label>
        </span>
        {ping ? <span className="text-xs text-muted-foreground">{ping}</span> : null}
        {err ? <span className="text-xs text-destructive">{err}</span> : null}
      </span>
      <span className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => setPing((await pingConnectionAction(c.id)).message))}
          className="rounded-md border border-border px-3 py-1 text-sm hover:border-primary"
        >
          Test
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await deleteConnectionAction(c.id);
              setErr(r.ok ? null : (r.message ?? 'Could not disconnect.'));
            })
          }
          className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
        >
          Disconnect
        </button>
      </span>
    </li>
  );
}

export function ConnectionsClient({ connections }: { connections: Connection[] }) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(createConnectionAction, null);

  return (
    <div className="flex flex-col gap-6">
      <ConnectCta />
      <ul className="flex flex-col gap-2">
        {connections.map((c) => (
          <ConnectionRow key={c.id} c={c} />
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
