'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { BookingMessages } from '@slate/shared';
import type { Connection } from '@/lib/admin-api';
import { FieldHelp } from '@/components/field-help';
import {
  connectCalendarAction,
  createConnectionAction,
  deleteConnectionAction,
  discoverConnectionsAction,
  pingConnectionAction,
  toggleConnectionAction,
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

const PROVIDERS: Array<{ key: string; labelKey: 'providerGoogle' | 'providerOutlook' }> = [
  { key: 'google', labelKey: 'providerGoogle' },
  { key: 'outlook', labelKey: 'providerOutlook' },
];

/**
 * The connect flow. Popup-blocker-safe: the popup is opened SYNCHRONOUSLY inside
 * the click gesture (to about:blank), then redirected to the minted connect URL
 * once the server responds — so Safari/Chrome never treat it as programmatic.
 * After the popup, we poll `discover` (server-side detection; no vendor SDK in
 * the browser — R15) until the new connection appears, then refresh.
 */
function ConnectDialog({
  open,
  onClose,
  enabled,
  baselineCount,
  m,
}: {
  open: boolean;
  onClose: () => void;
  enabled: boolean;
  baselineCount: number;
  m: ConnectionsMessages;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<'choose' | 'waiting'>('choose');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeProvider = useRef<string>('google');

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    popupRef.current = null;
    setStage('choose');
    setMsg(null);
    setErr(null);
  }, [stopPolling]);

  const finish = useCallback(
    (success: boolean) => {
      reset();
      onClose();
      if (success) router.refresh();
    },
    [reset, onClose, router],
  );

  // Poll for the just-connected account; success when the connection count grows.
  const checkForNew = useCallback(() => {
    void discoverConnectionsAction(activeProvider.current).then((r) => {
      if (r.ok && r.count > baselineCount) {
        setMsg(m.connectSuccess);
        finish(true);
      }
    });
  }, [baselineCount, finish, m.connectSuccess]);

  const beginConnect = (provider: string) => {
    setErr(null);
    activeProvider.current = provider;
    // Open the popup NOW, in the gesture, so it is not blocked.
    const popup = window.open('about:blank', 'slate-connect', 'width=520,height=720');
    if (!popup) {
      setErr(m.popupBlocked);
      return;
    }
    popupRef.current = popup;
    setStage('waiting');
    setMsg(m.connectHint);
    start(async () => {
      const r = await connectCalendarAction(provider);
      if (!r.enabled || !r.connectUrl) {
        if (!popup.closed) popup.close();
        setErr(r.message || m.connectFailed);
        setStage('choose');
        return;
      }
      popup.location.href = r.connectUrl;
      // Detect completion by polling the server (revalidated by the action).
      stopPolling();
      pollRef.current = setInterval(checkForNew, 2500);
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(false);
    window.addEventListener('keydown', onKey);
    // A refocus of our window is a strong signal the popup flow finished.
    const onFocus = () => {
      if (stage === 'waiting') checkForNew();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('focus', onFocus);
    };
  }, [open, stage, checkForNew, finish]);

  // Clean up timers/popup if the dialog unmounts.
  useEffect(() => () => reset(), [reset]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-hidden tabIndex={-1} onClick={() => finish(false)} className="absolute inset-0 bg-background/80" />
      <div role="dialog" aria-modal="true" aria-label={m.dialogTitle} className="relative w-full max-w-md rounded-xl border border-border bg-popover p-6 shadow-lg">
        <h2 className="mb-1 text-lg font-semibold">{m.dialogTitle}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{m.dialogSubtitle}</p>

        {stage === 'choose' ? (
          <div className="flex flex-col gap-2">
            {PROVIDERS.map(({ key, labelKey }) => (
              <button
                key={key}
                type="button"
                disabled={pending}
                onClick={() => beginConnect(key)}
                className="flex items-center gap-3 rounded-md border border-border px-4 py-3 text-sm transition-colors hover:border-primary disabled:opacity-60"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <ProviderIcon provider={key} />
                </span>
                <span className="flex-1 text-left font-medium">{m[labelKey]}</span>
                <span aria-hidden className="text-muted-foreground">→</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 p-5 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden />
            <span className="text-sm font-medium text-foreground">{m.connectWaiting}</span>
            <p className="text-sm text-muted-foreground">{msg ?? m.connectHint}</p>
            <button
              type="button"
              onClick={checkForNew}
              className="rounded-md border border-border px-4 py-2 text-sm hover:border-primary"
            >
              {m.connectDone}
            </button>
          </div>
        )}

        {err ? <p className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{err}</p> : null}

        {!enabled ? (
          <p className="mt-4 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            {m.syncOffDesc} {m.syncOffSetPre}{' '}
            <code className="rounded-sm bg-background px-1">CALENDAR_PROVIDER=external</code> {m.syncOffSetPost}
          </p>
        ) : null}

        {/* Advanced: manual reference add, kept OUT of the list surface (R30). */}
        <div className="mt-5 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showManual ? '▾' : '▸'} {m.manualTitle}
          </button>
          {showManual ? <ManualAddForm m={m} onAdded={() => finish(true)} /> : null}
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={() => finish(false)} className="rounded-md border border-border px-4 py-2 text-sm">
            {m.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Advanced manual-add: record a calendar reference by id (adapter/testing use). */
function ManualAddForm({ m, onAdded }: { m: ConnectionsMessages; onAdded: () => void }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      action={(form) =>
        start(async () => {
          const r = await createConnectionAction(null, form);
          if (r.ok) onAdded();
          else setErr(r.message ?? m.disconnectError);
        })
      }
    >
      <p className="text-xs text-muted-foreground">{m.manualDesc}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.provider}</span>
          <select name="provider" className="rounded-md border border-input bg-background px-3 py-2">
            <option value="google">google</option>
            <option value="outlook">outlook</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{m.calendarId}</span>
          <input name="externalId" required className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="checkConflicts" defaultChecked /> {m.conflictCheck.toLowerCase()}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="isDestination" /> {m.destination.toLowerCase()}
        </label>
        <button
          type="submit"
          disabled={pending}
          className="ml-auto rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-60"
        >
          {pending ? '…' : m.addConnection}
        </button>
      </div>
      {err ? <p className="text-sm text-destructive">{err}</p> : null}
    </form>
  );
}

function ConnectionRow({ c, m, enabled }: { c: Connection; m: ConnectionsMessages; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [ping, setPing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card p-4">
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <ProviderIcon provider={c.provider} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="font-medium capitalize">{c.provider}</span>
            {!enabled ? (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {m.healthRecorded}
              </span>
            ) : null}
          </span>
          <span className="truncate text-sm text-muted-foreground">{c.primaryEmail ?? c.externalId}</span>
          <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={c.isDestination}
                disabled={pending}
                onChange={(e) => start(() => toggleConnectionAction(c.id, { isDestination: e.target.checked }))}
              />
              {m.destination}
              <FieldHelp text={m.destinationHelp} />
            </label>
            <label className="flex items-center gap-1">
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

export interface ProviderStatus {
  enabled: boolean;
  message: string;
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
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      {/* Header: honest sync status on the left, primary Connect at top-right
          (R30 list/create pattern — creation happens in the dialog surface). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm">
          <span
            className={`flex h-2.5 w-2.5 rounded-full ${status.enabled ? 'bg-primary' : 'bg-muted-foreground/60'}`}
            aria-hidden
          />
          <span className="font-medium text-foreground">{status.enabled ? m.syncOnTitle : m.syncOffTitle}</span>
        </span>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
        >
          {m.connectButton}
        </button>
      </div>

      {connections.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {connections.map((c) => (
            <ConnectionRow key={c.id} c={c} m={m} enabled={status.enabled} />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-10 text-center">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
            <rect x="3" y="4.5" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 2.5v4M16 2.5v4" />
          </svg>
          <p className="text-sm text-muted-foreground">{m.noCalendars}</p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="text-sm text-primary hover:underline"
          >
            {m.connectLink}
          </button>
        </div>
      )}

      <ConnectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        enabled={status.enabled}
        baselineCount={connections.length}
        m={m}
      />
    </div>
  );
}
