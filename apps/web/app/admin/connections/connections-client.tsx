'use client';

import { useEffect, useActionState, useState, useTransition } from 'react';
import type { BookingMessages } from '@slate/shared';
import type { Connection } from '@/lib/admin-api';
import { FieldHelp } from '@/components/field-help';
import {
  connectCalendarAction,
  createConnectionAction,
  deleteConnectionAction,
  pingConnectionAction,
  toggleConnectionAction,
  type ActionResult,
} from './actions';

type ConnectionsMessages = BookingMessages['admin']['connections'];

/** End-provider mark (R15-safe: Google/Outlook are end-provider names). Generic
 *  calendar glyph for anything else. */
function ProviderIcon({ provider }: { provider: string }) {
  const p = provider.toLowerCase();
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true } as const;
  if (p.includes('google')) {
    return (
      <svg {...common}>
        <path fill="#4285F4" d="M21.6 12.2c0-.6-.05-1.2-.15-1.7H12v3.4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
        <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
        <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
        <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.4 3-4.1 5.6-4.1Z" />
      </svg>
    );
  }
  if (p.includes('outlook') || p.includes('microsoft')) {
    return (
      <svg {...common}>
        <rect x="3" y="6" width="12" height="12" rx="2" fill="#0A6ED1" />
        <path fill="#fff" d="M9 9.2c1.6 0 2.6 1.2 2.6 2.9S10.6 15 9 15s-2.6-1.2-2.6-2.9S7.4 9.2 9 9.2Zm0 1.4c-.8 0-1.2.7-1.2 1.5s.4 1.5 1.2 1.5 1.2-.7 1.2-1.5-.4-1.5-1.2-1.5Z" />
        <path fill="#0A6ED1" d="M15 8.5 21 7v10l-6-1.5Z" />
      </svg>
    );
  }
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

/** Provider-choice dialog for the connect flow. Runs against the CalendarProvider
 *  port via connectCalendarAction: when a provider is configured it yields a
 *  connect token/URL; otherwise it honestly reports that sync is off. */
function ConnectDialog({ open, onClose, m }: { open: boolean; onClose: () => void; m: ConnectionsMessages }) {
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
  // User-facing end-provider choices (not the private integration vendor — R15).
  const providers = [m.providerGoogle, m.providerOutlook];
  const choose = () =>
    start(async () => {
      const r = await connectCalendarAction();
      // A configured provider returns a token → begin its flow; else report status.
      setMsg(r.message);
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-hidden tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-background/80" />
      <div role="dialog" aria-modal="true" aria-label={m.dialogTitle} className="relative w-full max-w-md rounded-xl border border-border bg-popover p-6 shadow-lg">
        <h2 className="mb-1 text-lg font-semibold">{m.dialogTitle}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{m.dialogSubtitle}</p>
        <div className="flex flex-col gap-2">
          {providers.map((label) => (
            <button
              key={label}
              type="button"
              disabled={pending}
              onClick={choose}
              className="flex items-center justify-between rounded-md border border-border px-4 py-3 text-sm transition-colors hover:border-primary disabled:opacity-60"
            >
              <span className="font-medium">{label}</span>
              <span aria-hidden className="text-muted-foreground">→</span>
            </button>
          ))}
        </div>
        {msg ? <p className="mt-4 rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">{msg}</p> : null}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm">
            {m.close}
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
function ProviderBanner({ status, m }: { status: ProviderStatus; m: ConnectionsMessages }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      {status.enabled ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/40 bg-primary/5 p-4">
          <span className="flex h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />
          <span className="flex-1 text-sm">
            <span className="font-medium text-foreground">{m.syncOnTitle}</span>{' '}
            <span className="text-muted-foreground">{m.syncOnDesc}</span>
          </span>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {m.connectButton}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-4">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="flex h-2.5 w-2.5 rounded-full bg-muted-foreground/60" aria-hidden />
            {m.syncOffTitle}
          </span>
          <p className="text-sm text-muted-foreground">
            {m.syncOffDesc} {m.syncOffSetPre}{' '}
            <code className="rounded-sm bg-background px-1">CALENDAR_PROVIDER=external</code> {m.syncOffSetPost}
          </p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="self-start text-sm text-primary hover:underline"
          >
            {m.connectLink}
          </button>
        </div>
      )}
      <ConnectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} m={m} />
    </>
  );
}

function ConnectionRow({ c, m, enabled }: { c: Connection; m: ConnectionsMessages; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [ping, setPing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-4">
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <ProviderIcon provider={c.provider} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="font-medium capitalize">{c.provider}</span>
            {/* Honest health tag: green when a provider is wired (syncing), muted
                when the OSS default just records the connection. */}
            <span
              className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${
                enabled ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              {enabled ? m.healthSyncing : m.healthRecorded}
            </span>
          </span>
          <span className="truncate text-sm text-muted-foreground">{c.primaryEmail ?? c.externalId}</span>
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <label className="flex items-center gap-1" title={m.destinationHelp}>
              <input
                type="checkbox"
                checked={c.isDestination}
                disabled={pending}
                onChange={(e) => start(() => toggleConnectionAction(c.id, { isDestination: e.target.checked }))}
              />
              {m.destination}
              <FieldHelp text={m.destinationHelp} />
            </label>
            <label className="flex items-center gap-1" title={m.conflictHelp}>
              <input
                type="checkbox"
                checked={c.checkConflicts}
                disabled={pending}
                onChange={(e) => start(() => toggleConnectionAction(c.id, { checkConflicts: e.target.checked }))}
              />
              {m.conflictCheck}
              <FieldHelp text={m.conflictHelp} />
            </label>
          </span>
          {ping ? <span className="text-xs text-muted-foreground">{ping}</span> : null}
          {err ? <span className="text-xs text-destructive">{err}</span> : null}
        </span>
      </span>
      <span className="flex shrink-0 gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => setPing((await pingConnectionAction(c.id)).message))}
          className="rounded-md border border-border px-3 py-1 text-sm hover:border-primary"
        >
          {m.test}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await deleteConnectionAction(c.id);
              setErr(r.ok ? null : (r.message ?? m.disconnectError));
            })
          }
          className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
        >
          {m.disconnect}
        </button>
      </span>
    </li>
  );
}

export function ConnectionsClient({
  connections,
  status,
  messages: m,
}: {
  connections: Connection[];
  status: ProviderStatus;
  messages: ConnectionsMessages;
}) {
  const [res, action, pending] = useActionState<ActionResult | null, FormData>(createConnectionAction, null);

  return (
    <div className="flex flex-col gap-6">
      <ProviderBanner status={status} m={m} />
      {connections.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <ConnectionRow key={c.id} c={c} m={m} enabled={status.enabled} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-8 text-center">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
            <rect x="3" y="4.5" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 2.5v4M16 2.5v4" />
          </svg>
          <p className="text-sm text-muted-foreground">{m.noCalendars}</p>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-medium text-foreground">{m.manualTitle}</h3>
        <p className="mb-2 text-xs text-muted-foreground">{m.manualDesc}</p>
        <form action={action} className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{m.provider}</span>
          <select name="provider" className="rounded-md border border-input bg-background px-3 py-2">
            <option value="google">google</option>
            <option value="outlook">outlook</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.calendarId}</span>
          <input name="externalId" required className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="checkConflicts" defaultChecked /> {m.conflictCheck.toLowerCase()}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isDestination" /> {m.destination.toLowerCase()}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? '…' : m.addConnection}
        </button>
          {res && !res.ok ? <p className="w-full text-sm text-destructive">{res.message}</p> : null}
        </form>
      </div>
    </div>
  );
}
