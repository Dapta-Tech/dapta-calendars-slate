'use client';

import { useEffect, useActionState, useState, useTransition } from 'react';
import type { Connection } from '@/lib/admin-api';
import {
  connectCalendarAction,
  createConnectionAction,
  deleteConnectionAction,
  pingConnectionAction,
  toggleConnectionAction,
  type ActionResult,
} from './actions';

// User-facing end-provider choices (not the private integration vendor — R15).
const PROVIDERS = [
  { id: 'google', label: 'Google Calendar' },
  { id: 'outlook', label: 'Outlook / Microsoft 365' },
] as const;

/** Provider-choice dialog for the connect flow. Runs against the CalendarProvider
 *  port via connectCalendarAction: when a provider is configured it yields a
 *  connect token/URL; otherwise it honestly reports that sync is off. */
function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const choose = () =>
    start(async () => {
      const r = await connectCalendarAction();
      // A configured provider returns a token → begin its flow; else report status.
      setMsg(r.message);
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-hidden tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-background/80" />
      <div role="dialog" aria-modal="true" aria-label="Connect a calendar" className="relative w-full max-w-md rounded-xl border border-border bg-popover p-6 shadow-lg">
        <h2 className="mb-1 text-lg font-semibold">Connect a calendar</h2>
        <p className="mb-4 text-sm text-muted-foreground">Choose a provider to link.</p>
        <div className="flex flex-col gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={pending}
              onClick={choose}
              className="flex items-center justify-between rounded-md border border-border px-4 py-3 text-sm transition-colors hover:border-primary disabled:opacity-60"
            >
              <span className="font-medium">{p.label}</span>
              <span aria-hidden className="text-muted-foreground">→</span>
            </button>
          ))}
        </div>
        {msg ? <p className="mt-4 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">{msg}</p> : null}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ProviderStatus {
  enabled: boolean;
  message: string;
}

/** Status-aware header: clearly says whether calendar sync is ON, and drives the
 *  connect flow accordingly (fixes "los calendarios no se conectan" — the OSS
 *  default has no provider wired, which the old UI never communicated). */
function ProviderBanner({ status }: { status: ProviderStatus }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      {status.enabled ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/40 bg-primary/5 p-4">
          <span className="flex h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
          <span className="flex-1 text-sm">
            <span className="font-medium text-foreground">Calendar sync is on.</span>{' '}
            <span className="text-muted-foreground">Connect Google or Outlook to check conflicts and write events.</span>
          </span>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            Connect a calendar
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-4">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="flex h-2.5 w-2.5 rounded-full bg-muted-foreground/60" aria-hidden />
            Calendar sync is off in this build
          </span>
          <p className="text-sm text-muted-foreground">
            No external calendar provider is configured, so Slate isn’t reading busy times or writing events yet.
            Connections you add below are <strong>recorded</strong> but not synced. To turn sync on, set{' '}
            <code className="rounded-sm bg-background px-1">CALENDAR_PROVIDER=external</code> and configure a provider
            adapter in your deployment.
          </p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="self-start text-sm text-primary hover:underline"
          >
            Connect a calendar →
          </button>
        </div>
      )}
      <ConnectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
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

export function ConnectionsClient({
  connections,
  status,
}: {
  connections: Connection[];
  status: ProviderStatus;
}) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(createConnectionAction, null);

  return (
    <div className="flex flex-col gap-6">
      <ProviderBanner status={status} />
      <ul className="flex flex-col gap-2">
        {connections.map((c) => (
          <ConnectionRow key={c.id} c={c} />
        ))}
        {connections.length === 0 ? (
          <li className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No calendars linked yet.
          </li>
        ) : null}
      </ul>

      <div>
        <h3 className="mb-1 text-sm font-medium text-foreground">Link a calendar manually</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Advanced: record a calendar reference by id (used when a provider adapter is configured, or for testing).
        </p>
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
    </div>
  );
}
